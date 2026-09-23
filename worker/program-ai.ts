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

/** קריאה ל־Claude (Messages API) עם הנחיית מערכת והודעה אחת; מחזיר את הטקסט. */
async function askClaude(env: Env, system: string, content: string, maxTokens: number): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": String(env.ANTHROPIC_API_KEY), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await response.json().catch(() => null) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string; error?: { message?: string } } | null;
  if (!response.ok || !data) throw new Error(`anthropic ${response.status}: ${data?.error?.message || ""}`);
  if (data.stop_reason === "refusal") throw new Error("anthropic refusal");
  return (data.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("");
}

/** קריאה ל־Llama של Workers AI; מחזיר את התשובה כפי שהיא (בדרך כלל טקסט). */
async function askWorkersAi(env: Env, system: string, content: string, maxTokens: number): Promise<unknown> {
  const result = await env.AI!.run(LLAMA_MODEL, {
    messages: [{ role: "system", content: system }, { role: "user", content }],
    max_tokens: maxTokens,
  }) as { response?: unknown } | string;
  return typeof result === "string" ? result : result?.response;
}

const summarizeWithClaude = (env: Env, transcript: string) => askClaude(env, SUMMARY_SYSTEM, `התמלול:\n\n${transcript.slice(0, CLAUDE_CHARS)}`, 4000);
const summarizeWithWorkersAi = (env: Env, transcript: string) => askWorkersAi(env, SUMMARY_SYSTEM, `התמלול:\n\n${transcript.slice(0, LLAMA_CHARS)}`, 2048);

/* ---------- הגהה: תיקון כתיב בלבד בטקסטים של האתר ---------- */
export const PROOFREAD_MAX_ITEMS = 40;
export const PROOFREAD_MAX_CHARS = 40_000;
export const PROOFREAD_MAX_CHANGES = 30;

export const PROOFREAD_SYSTEM = `אתה מגיה טקסטים בעברית של אתר "ראש בראש" — תוכנית רדיו חרדית של מוזיקה ואקטואליה. תקבל מערך JSON של פריטים, לכל אחד "key" ו־"text".
תקן רק:
- שגיאות כתיב והקלדה בעברית;
- גרשיים שנכתבו כשני גרשים (''), או כמירכאות רגילות בתוך ראשי תיבות — הפוך אותם ל־״ (למשל: בע''ה ← בע״ה);
- רווח חסר אחרי סימן פיסוק (נקודה, פסיק, נקודתיים, סימן שאלה או קריאה);
- התאמה שגויה במין או במספר (למשל: "התוכנית החדש" ← "התוכנית החדשה").
אסור לנסח מחדש, לקצר, להוסיף או להשמיט מילים, לשנות סגנון, לשנות שמות של אנשים, אמנים, שירים או מקומות, או לגעת בקישורים, במספרים ובאימוג׳ים — השאר אותם בדיוק כפי שהם. שמור על ירידות השורה.
החזר JSON תקין בלבד, בלי שום טקסט לפניו או אחריו, במבנה:
{"results": [{"key": "...", "fixed": "..."}]}
כלול רק פריטים שדרוש בהם תיקון, עם הטקסט המלא המתוקן ב־"fixed" ועם אותו "key" בדיוק. אם אין מה לתקן — {"results": []}.`;

export type ProofreadItem = { key: string; text: string };
export type ProofreadChange = { from: string; to: string };

/** בודק את גוף הבקשה: 1–40 פריטים, מפתח וטקסט לכל אחד, ועד 40,000 תווים בסך הכול. */
export function validateProofreadItems(raw: unknown): ProofreadItem[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PROOFREAD_MAX_ITEMS) return null;
  const items: ProofreadItem[] = [];
  let total = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { key, text } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !key.trim() || key.length > 200 || typeof text !== "string") return null;
    total += text.length;
    if (total > PROOFREAD_MAX_CHARS) return null;
    items.push({ key, text });
  }
  return new Set(items.map((item) => item.key)).size === items.length ? items : null;
}

/** מוציא {results:[{key,fixed}]} מתשובת המודל (גם כשהיא עטופה בטקסט או ב־```). */
export function parseProofread(raw: unknown): Array<{ key: string; fixed: string }> | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/```(?:json)?/gi, "");
    const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { value = JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) return null;
  return ((value as { results: unknown[] }).results).flatMap((entry) => {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    return typeof item.key === "string" && typeof item.fixed === "string" ? [{ key: item.key, fixed: item.fixed }] : [];
  });
}

const SYNC_WINDOW = 6;
/**
 * השינויים ברמת המילה בין הטקסט המקורי למתוקן. המילים עוברות זו מול זו; כשהן
 * נפרדות מחפשים את נקודת החיבור הקרובה (עד 6 מילים קדימה בכל צד) — שתי מילים
 * זהות ברצף, או סוף הטקסט — וכל מה שבין לבין הוא שינוי אחד.
 */
export function wordChanges(before: string, after: string, max = PROOFREAD_MAX_CHANGES): ProofreadChange[] {
  const a = before.split(/\s+/).filter(Boolean), b = after.split(/\s+/).filter(Boolean);
  const changes: ProofreadChange[] = [];
  const anchored = (i: number, j: number) => a[i] === b[j] && (i + 1 >= a.length || j + 1 >= b.length || a[i + 1] === b[j + 1]);
  let i = 0, j = 0;
  while (i < a.length && j < b.length && changes.length < max) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    let skip: [number, number] | null = null;
    for (let sum = 1; sum <= 2 * SYNC_WINDOW && !skip; sum += 1) {
      for (let di = Math.max(0, sum - SYNC_WINDOW); di <= Math.min(sum, SYNC_WINDOW) && !skip; di += 1) {
        const dj = sum - di;
        if (i + di < a.length && j + dj < b.length && anchored(i + di, j + dj)) skip = [di, dj];
      }
    }
    const [di, dj] = skip ?? [1, 1];
    changes.push({ from: a.slice(i, i + di).join(" "), to: b.slice(j, j + dj).join(" ") });
    i += di; j += dj;
  }
  if ((i < a.length || j < b.length) && changes.length < max) changes.push({ from: a.slice(i).join(" "), to: b.slice(j).join(" ") });
  return changes;
}

/** תשובת ההגהה: רק פריטים שהשתנו באמת, כל אחד עם רשימת השינויים שלו. */
export function proofreadResults(items: ProofreadItem[], fixes: Array<{ key: string; fixed: string }>) {
  const byKey = new Map(items.map((item) => [item.key, item.text]));
  const seen = new Set<string>();
  return fixes.flatMap(({ key, fixed }) => {
    const text = byKey.get(key);
    if (text === undefined || seen.has(key) || !fixed.trim() || fixed === text) return [];
    seen.add(key);
    return [{ key, fixed, changes: wordChanges(text, fixed) }];
  });
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
  if (path === "/ai/proofread" && request.method === "POST") {
    const input = await body<{ items?: unknown }>();
    const items = validateProofreadItems(input.items);
    if (!items) return h.reply(request, { error: `צריך לשלוח בין 1 ל־${PROOFREAD_MAX_ITEMS} טקסטים עם מפתח שונה לכל אחד, ועד ${PROOFREAD_MAX_CHARS.toLocaleString("en-US")} תווים בסך הכול.` }, 400);
    const useClaude = !!env.ANTHROPIC_API_KEY;
    if (!useClaude && !env.AI) return h.reply(request, { error: "שירות הבינה המלאכותית אינו מחובר לוורקר." }, 503);
    const content = `הפריטים להגהה:\n\n${JSON.stringify(items)}`;
    let fixes: Array<{ key: string; fixed: string }> | null = null;
    try {
      fixes = parseProofread(useClaude ? await askClaude(env, PROOFREAD_SYSTEM, content, 32000) : await askWorkersAi(env, PROOFREAD_SYSTEM, content, 4096));
    } catch (error) {
      console.error("program proofread error", error);
      return h.reply(request, { error: "ההגהה נכשלה בשירות הבינה המלאכותית. נסו שוב בעוד רגע." }, 502);
    }
    if (!fixes) return h.reply(request, { error: "שירות הבינה המלאכותית החזיר תשובה שאי אפשר לקרוא. נסו שוב." }, 502);
    return h.reply(request, { results: proofreadResults(items, fixes) });
  }
  return null;
}
