/* תמלול וסיכום של תוכניות בבינה מלאכותית (למנהלים בלבד). התמלול נעשה
   ב־Workers AI (Whisper) בחלקים של 2MB שהלקוח מבקש בזה אחר זה; הסיכום —
   ב־Claude כשמוגדר ANTHROPIC_API_KEY, ואחרת ב־Workers AI (Llama). התמלולים
   יושבים בטבלה נפרדת ולעולם אינם חלק מהקטלוג הציבורי. */
import type { SessionUser } from "./auth";
import { loadEpisode, locateAudio } from "./program-audio";

export type AiBinding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };
type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string; AI?: AiBinding; ANTHROPIC_API_KEY?: string };
type Helpers = {
  reply: (request: Request, body: unknown, status?: number) => Response;
  admin: (request: Request, env: Env) => Promise<SessionUser | null>;
  safeId: (value: unknown) => string;
};

export const TRANSCRIBE_CHUNK = 2 * 1024 * 1024;
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const LLAMA_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_CHARS = 60_000;
const LLAMA_CHARS = 20_000;

export type EpisodeSummary = { description: string; summary: string; tags: string[]; guests: string[] };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const SUMMARY_SYSTEM = `אתה עורך תוכן של "ראש בראש" — תוכנית רדיו חרדית של מוזיקה ואקטואליה. תקבל תמלול אוטומטי (ייתכנו בו שגיאות זיהוי) של תוכנית אחת.
החזר JSON תקין בלבד, בלי שום טקסט לפניו או אחריו, במבנה:
{"description": "...", "summary": "...", "tags": ["..."], "guests": ["..."]}
- description: 2–4 משפטים בעברית, מזמינים, בגוף שלישי, בלי להמציא עובדות שלא נאמרו בתמלול.
- summary: סיכום בנקודות של הפינות העיקריות בתוכנית, 5–10 שורות מופרדות בירידת שורה, כל שורה מתחילה ב־"• ".
- tags: עד 8 מילות חיפוש קצרות בעברית.
- guests: שמות האורחים או האמנים שרואיינו — רק אם נאמרו במפורש; אחרת מערך ריק.`;

/** מוציא את אובייקט ה־JSON מתוך תשובת מודל (גם כשהוא עטוף בטקסט או ב־```), ומנרמל את השדות. */
export function parseSummary(raw: unknown): EpisodeSummary | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/```(?:json)?/gi, "");
    const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { value = JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const list = (items: unknown, max: number) => (Array.isArray(items) ? items : typeof items === "string" ? items.split(/[,،\n]/) : [])
    .map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, max);
  const summaryText = Array.isArray(v.summary) ? v.summary.map((line) => String(line).trim()).filter(Boolean).map((line) => (line.startsWith("•") ? line : `• ${line}`)).join("\n") : String(v.summary ?? "").trim();
  const result = { description: String(v.description ?? "").trim(), summary: summaryText, tags: list(v.tags, 8), guests: list(v.guests, 20) };
  return result.description || result.summary ? result : null;
}

async function summarizeWithClaude(env: Env, transcript: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": String(env.ANTHROPIC_API_KEY), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: `התמלול:\n\n${transcript.slice(0, CLAUDE_CHARS)}` }],
    }),
  });
  const data = await response.json().catch(() => null) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string; error?: { message?: string } } | null;
  if (!response.ok || !data) throw new Error(`anthropic ${response.status}: ${data?.error?.message || ""}`);
  if (data.stop_reason === "refusal") throw new Error("anthropic refusal");
  return (data.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("");
}

async function summarizeWithWorkersAi(env: Env, transcript: string): Promise<unknown> {
  const result = await env.AI!.run(LLAMA_MODEL, {
    messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: `התמלול:\n\n${transcript.slice(0, LLAMA_CHARS)}` }],
    max_tokens: 2048,
  }) as { response?: unknown } | string;
  return typeof result === "string" ? result : result?.response;
}

export async function programAiApi(request: Request, env: Env, h: Helpers): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/program".length);
  if (!path.startsWith("/ai/")) return null;
  if (!await h.admin(request, env)) return h.reply(request, { error: "אין הרשאת ניהול." }, 403);
  const body = async <T>() => { try { return await request.json<T>(); } catch { return {} as T; } };

  if (path === "/ai/transcribe" && request.method === "POST") {
    const input = await body<{ episodeId?: string; part?: number }>();
    const episodeId = h.safeId(input.episodeId);
    const part = Math.floor(Number(input.part ?? 0));
    if (!episodeId || !Number.isFinite(part) || part < 0) return h.reply(request, { error: "פרטי התמלול אינם תקינים." }, 400);
    if (!env.AI) return h.reply(request, { error: "שירות הבינה המלאכותית (Workers AI) אינו מחובר לוורקר." }, 503);
    const episode = await loadEpisode(env, episodeId);
    if (!episode) return h.reply(request, { error: "התוכנית לא נמצאה." }, 404);
    const audio = await locateAudio(env, episode.data, url.origin);
    if (!audio || !audio.size) return h.reply(request, { error: "ההקלטה של התוכנית אינה שמורה ב־R2, ולכן אי אפשר לתמלל אותה." }, 404);
    const partsTotal = Math.ceil(audio.size / TRANSCRIBE_CHUNK);
    if (part >= partsTotal) return h.reply(request, { error: "החלק המבוקש מעבר לסוף ההקלטה." }, 400);
    const offset = part * TRANSCRIBE_CHUNK;
    const object = await env.MEDIA.get(audio.key, { range: { offset, length: Math.min(TRANSCRIBE_CHUNK, audio.size - offset) } });
    if (!object) return h.reply(request, { error: "ההקלטה אינה זמינה כרגע." }, 404);
    const bytes = new Uint8Array(await object.arrayBuffer());
    let chunkText = "";
    try {
      const result = await env.AI.run(WHISPER_MODEL, { audio: toBase64(bytes), language: "he" }) as { text?: string };
      chunkText = String(result?.text ?? "").trim();
    } catch (error) {
      console.error("program transcribe error", episode.id, part, error);
      return h.reply(request, { error: "התמלול נכשל בשירות הבינה המלאכותית. נסו שוב בעוד רגע." }, 502);
    }
    if (part === 0) {
      await env.DB.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total,summary_json,updated_at) VALUES (?,?,1,?,NULL,unixepoch()) ON CONFLICT(episode_id) DO UPDATE SET text=excluded.text,parts_done=1,parts_total=excluded.parts_total,summary_json=NULL,updated_at=unixepoch()")
        .bind(episode.id, chunkText, partsTotal).run();
    } else {
      await env.DB.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total,updated_at) VALUES (?,?,?,?,unixepoch()) ON CONFLICT(episode_id) DO UPDATE SET text=CASE WHEN program_transcripts.text='' THEN excluded.text WHEN excluded.text='' THEN program_transcripts.text ELSE program_transcripts.text || ' ' || excluded.text END,parts_done=excluded.parts_done,parts_total=excluded.parts_total,updated_at=unixepoch()")
        .bind(episode.id, chunkText, part + 1, partsTotal).run();
    }
    return h.reply(request, { part, partsTotal, done: part + 1 >= partsTotal, text: chunkText });
  }

  if (path.startsWith("/ai/transcript/") && request.method === "GET") {
    const episodeId = h.safeId(decodeURIComponent(path.slice("/ai/transcript/".length)));
    const row = await env.DB.prepare("SELECT text,parts_done,parts_total,summary_json,updated_at FROM program_transcripts WHERE episode_id=?").bind(episodeId)
      .first<{ text: string; parts_done: number; parts_total: number; summary_json: string | null; updated_at: number }>();
    if (!row) return h.reply(request, { text: "", partsDone: 0, partsTotal: 0, summary: null, updatedAt: null });
    let summary = null;
    try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch { summary = null; }
    return h.reply(request, { text: row.text, partsDone: Number(row.parts_done), partsTotal: Number(row.parts_total), summary, updatedAt: new Date(Number(row.updated_at) * 1000).toISOString() });
  }

  if (path === "/ai/summarize" && request.method === "POST") {
    const { episodeId: raw } = await body<{ episodeId?: string }>();
    const episodeId = h.safeId(raw);
    const row = await env.DB.prepare("SELECT text,parts_done,parts_total FROM program_transcripts WHERE episode_id=?").bind(episodeId)
      .first<{ text: string; parts_done: number; parts_total: number }>();
    if (!row || !Number(row.parts_total) || Number(row.parts_done) < Number(row.parts_total) || !row.text.trim()) {
      return h.reply(request, { error: "צריך קודם להשלים את התמלול של התוכנית." }, 409);
    }
    const useClaude = !!env.ANTHROPIC_API_KEY;
    if (!useClaude && !env.AI) return h.reply(request, { error: "שירות הבינה המלאכותית אינו מחובר לוורקר." }, 503);
    let parsed: EpisodeSummary | null = null;
    try {
      parsed = parseSummary(useClaude ? await summarizeWithClaude(env, row.text) : await summarizeWithWorkersAi(env, row.text));
    } catch (error) {
      console.error("program summarize error", episodeId, error);
      return h.reply(request, { error: "יצירת התיאור נכשלה בשירות הבינה המלאכותית. נסו שוב בעוד רגע." }, 502);
    }
    if (!parsed) return h.reply(request, { error: "שירות הבינה המלאכותית החזיר תשובה שאי אפשר לקרוא. נסו שוב." }, 502);
    const stored = { ...parsed, model: useClaude ? CLAUDE_MODEL : LLAMA_MODEL, createdAt: new Date().toISOString() };
    await env.DB.prepare("UPDATE program_transcripts SET summary_json=?,updated_at=unixepoch() WHERE episode_id=?").bind(JSON.stringify(stored), episodeId).run();
    return h.reply(request, stored);
  }
  return null;
}
