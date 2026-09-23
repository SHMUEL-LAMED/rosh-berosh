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
const DAILY_AUTO_PARTS = 60;
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

/** Shared by the manager button and the scheduled job. Never mark an empty AI answer as a completed part. */
export async function transcribeProgramPart(env: Env, episodeId: string, part: number, origin: string, expectedAudioKey?: string) {
  if (!env.AI) throw new Error("שירות Workers AI אינו מחובר.");
  const episode = await loadEpisode(env, episodeId);
  if (!episode) throw new Error("התוכנית לא נמצאה.");
  const audio = await locateAudio(env, episode.data, origin);
  if (!audio?.size) throw new Error("ההקלטה אינה שמורה ב־R2.");
  if (expectedAudioKey && audio.key !== expectedAudioKey) throw new Error("ההקלטה הוחלפה בזמן התמלול.");
  const partsTotal = Math.ceil(audio.size / TRANSCRIBE_CHUNK);
  if (part < 0 || part >= partsTotal) throw new Error("חלק ההקלטה אינו תקין.");
  const object = await env.MEDIA.get(audio.key, { range: { offset: part * TRANSCRIBE_CHUNK, length: Math.min(TRANSCRIBE_CHUNK, audio.size - part * TRANSCRIBE_CHUNK) } });
  if (!object) throw new Error("ההקלטה אינה זמינה.");
  const result = await env.AI.run(WHISPER_MODEL, { audio: toBase64(new Uint8Array(await object.arrayBuffer())), language: "he" }) as { text?: string };
  const chunkText = String(result?.text ?? "").trim();
  if (!chunkText) throw new Error("שירות התמלול החזיר חלק ריק.");
  const row = await env.DB.prepare("SELECT text,parts_json,parts_done,parts_total FROM program_transcripts WHERE episode_id=?").bind(episode.id)
    .first<{ text: string; parts_json: string | null; parts_done: number; parts_total: number }>();
  if (expectedAudioKey && part > 0 && (Number(row?.parts_done) !== part || Number(row?.parts_total) !== partsTotal))
    throw new Error("התקדמות התמלול השתנתה; החלק לא נשמר.");
  const parts = transcriptParts(row, partsTotal);
  parts[part] = chunkText;
  let partsDone = 0;
  while (partsDone < partsTotal && typeof parts[partsDone] === "string") partsDone += 1;
  const text = parts.filter((value): value is string => typeof value === "string" && !!value).join(" ");
  await env.DB.prepare(`INSERT INTO program_transcripts (episode_id,text,parts_json,parts_done,parts_total,summary_json,updated_at) VALUES (?,?,?,?,?,NULL,unixepoch()) ON CONFLICT(episode_id) DO UPDATE SET text=excluded.text,parts_json=excluded.parts_json,parts_done=excluded.parts_done,parts_total=excluded.parts_total,${part === 0 ? "summary_json=NULL," : ""}updated_at=unixepoch()`)
    .bind(episode.id, text, JSON.stringify(parts.map((value) => (typeof value === "string" ? value : null))), partsDone, partsTotal).run();
  return { part, partsDone, partsTotal, done: partsDone >= partsTotal, text: chunkText, audioKey: audio.key };
}

/** One part per scheduled invocation. A failed part is retried; a finished recording leaves the queue. */
export async function runAutomaticTranscription(env: Env, origin: string): Promise<void> {
  if (!env.AI) return;
  const marker = await env.DB.prepare("SELECT 1 FROM program_settings WHERE key='program-auto-transcription-initialized'").first();
  if (!marker) {
    // Start with the newest existing recording; old archives are not queued en masse.
    const latest = await env.DB.prepare("SELECT id,data_json FROM program_episodes WHERE visible=1 ORDER BY date DESC,number DESC LIMIT 1").first<{ id: string; data_json: string }>();
    if (latest) {
      const data = JSON.parse(latest.data_json) as { r2Key?: string };
      const transcript = await env.DB.prepare("SELECT parts_done,parts_total FROM program_transcripts WHERE episode_id=?").bind(latest.id).first<{ parts_done: number; parts_total: number }>();
      if (data.r2Key && (!transcript?.parts_total || transcript.parts_done < transcript.parts_total)) {
        await env.DB.prepare("INSERT OR IGNORE INTO program_transcription_jobs (episode_id,audio_key) VALUES (?,?)").bind(latest.id, data.r2Key).run();
      }
    }
    await env.DB.prepare("INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES ('program-auto-transcription-initialized','true',unixepoch())").run();
  }
  const today = new Date().toISOString().slice(0, 10);
  const usage = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key='program-auto-transcription-usage'").first<{ value_json: string }>();
  let count = 0;
  try { const value = JSON.parse(usage?.value_json || "null"); if (value?.day === today) count = Number(value.count) || 0; } catch { /* reset malformed counter */ }
  if (count >= DAILY_AUTO_PARTS) return;
  const job = await env.DB.prepare("SELECT episode_id,audio_key,attempts FROM program_transcription_jobs WHERE next_at<=unixepoch() ORDER BY updated_at,episode_id LIMIT 1")
    .first<{ episode_id: string; audio_key: string; attempts: number }>();
  if (!job) return;
  const claim = await env.DB.prepare("UPDATE program_transcription_jobs SET next_at=unixepoch()+300,updated_at=unixepoch() WHERE episode_id=? AND next_at<=unixepoch() RETURNING episode_id")
    .bind(job.episode_id).first();
  if (!claim) return;
  try {
    const progress = await env.DB.prepare("SELECT parts_done,parts_total FROM program_transcripts WHERE episode_id=?").bind(job.episode_id).first<{ parts_done: number; parts_total: number }>();
    if (progress?.parts_total && progress.parts_done >= progress.parts_total) {
      await env.DB.prepare("DELETE FROM program_transcription_jobs WHERE episode_id=? AND audio_key=?").bind(job.episode_id, job.audio_key).run();
      return;
    }
    const part = Number(progress?.parts_done) || 0;
    const result = await transcribeProgramPart(env, job.episode_id, part, origin, job.audio_key);
    await env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('program-auto-transcription-usage',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()")
      .bind(JSON.stringify({ day: today, count: count + 1 })).run();
    if (result.done) await env.DB.prepare("DELETE FROM program_transcription_jobs WHERE episode_id=? AND audio_key=?").bind(job.episode_id, job.audio_key).run();
    else await env.DB.prepare("UPDATE program_transcription_jobs SET attempts=0,last_error=NULL,next_at=0,updated_at=unixepoch() WHERE episode_id=? AND audio_key=?")
      .bind(job.episode_id, job.audio_key).run();
  } catch (error) {
    const attempts = job.attempts + 1;
    console.error("automatic program transcription failed", job.episode_id, error);
    await env.DB.prepare("UPDATE program_transcription_jobs SET attempts=?,last_error=?,next_at=unixepoch()+?,updated_at=unixepoch() WHERE episode_id=? AND audio_key=?")
      .bind(attempts, String(error instanceof Error ? error.message : error).slice(0, 300), attempts >= 5 ? 86400 : Math.min(3600, 300 * 2 ** attempts), job.episode_id, job.audio_key).run();
  }
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

/* ---------- הצעות לשם התוכנית ולהודעת וואטסאפ, מתוך התמלול ---------- */
export const TITLES_SYSTEM = `אתה עורך תוכן של "ראש בראש" — תוכנית רדיו חרדית של מוזיקה ואקטואליה. תקבל תמלול אוטומטי (ייתכנו בו שגיאות זיהוי) של תוכנית אחת.
החזר JSON תקין בלבד, בלי שום טקסט לפניו או אחריו, במבנה:
{"titles": ["...", "...", "...", "...", "..."], "whatsapp": "..."}
- titles: בדיוק 5 הצעות לשם התוכנית בעברית — קצרות וקולעות, 2–6 מילים כל אחת, בלי מירכאות ובלי מספר תוכנית, מבוססות על מה שנאמר בתמלול בלבד.
- whatsapp: הודעת פתיחה לוואטסאפ בעברית, 2–3 שורות (מופרדות בירידת שורה), שמזמינה להאזין לתוכנית; מותר 1–2 אימוג׳ים, בלי קישורים.`;

export type TitleSuggestions = { titles: string[]; whatsapp: string };

/** מוציא {titles, whatsapp} מתשובת המודל (גם כשהיא עטופה בטקסט או ב־```): שמות נקיים, בלי כפילויות, עד 5. */
export function parseTitles(raw: unknown): TitleSuggestions | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/```(?:json)?/gi, "");
    const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { value = JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const seen = new Set<string>();
  const titles = (Array.isArray(v.titles) ? v.titles : []).flatMap((item) => {
    if (typeof item !== "string") return [];
    const title = item.replace(/^\s*(?:\d+[.)]\s*|[-•*]\s*)/, "").replace(/^["״“”„]+|["״“”„]+$/g, "").replace(/\s+/g, " ").trim();
    if (!title || seen.has(title)) return [];
    seen.add(title);
    return [title];
  }).slice(0, 5);
  const whatsapp = typeof v.whatsapp === "string" ? v.whatsapp.trim() : "";
  return titles.length ? { titles, whatsapp } : null;
}

/**
 * הטקסט של כל חלק בתמלול השמור (null — חלק שעוד לא תומלל). אם ההקלטה השתנתה
 * (מספר חלקים אחר) מתחילים מאפס. תמלול מלפני שנשמר כל חלק בנפרד: הטקסט
 * המצטבר נחשב לחלק הראשון, והחלקים שאחריו שכבר נעשו — לריקים.
 */
export function transcriptParts(row: { text: string; parts_json: string | null; parts_done: number; parts_total: number } | null, partsTotal: number): Array<string | null> {
  if (!row || Number(row.parts_total) !== partsTotal) return [];
  if (row.parts_json) {
    try {
      const saved = JSON.parse(row.parts_json);
      if (Array.isArray(saved)) return saved.slice(0, partsTotal).map((value) => (typeof value === "string" ? value : null));
    } catch { /* פגום — מתחילים מאפס */ }
    return [];
  }
  const done = Math.min(partsTotal, Math.max(0, Math.floor(Number(row.parts_done) || 0)));
  return Array.from({ length: done }, (_, index) => (index === 0 ? String(row.text || "") : ""));
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
    try {
      const result = await transcribeProgramPart(env, episodeId, part, url.origin);
      return h.reply(request, result);
    } catch (error) {
      console.error("program transcribe error", episodeId, part, error);
      const message = error instanceof Error && /חלק ריק|אינה שמורה|אינו מחובר|התקדמות/.test(error.message)
        ? error.message : "התמלול נכשל בשירות הבינה המלאכותית. נסו שוב בעוד רגע.";
      return h.reply(request, { error: message }, 502);
    }
  }

  if (path.startsWith("/ai/transcript/") && request.method === "GET") {
    const episodeId = h.safeId(decodeURIComponent(path.slice("/ai/transcript/".length)));
    const row = await env.DB.prepare("SELECT text,parts_done,parts_total,summary_json,updated_at FROM program_transcripts WHERE episode_id=?").bind(episodeId)
      .first<{ text: string; parts_done: number; parts_total: number; summary_json: string | null; updated_at: number }>();
    const job = await env.DB.prepare("SELECT attempts,last_error,next_at FROM program_transcription_jobs WHERE episode_id=?").bind(episodeId)
      .first<{ attempts: number; last_error: string | null; next_at: number }>();
    if (!row) return h.reply(request, { text: "", partsDone: 0, partsTotal: 0, summary: null, updatedAt: null, automatic: job ? { attempts: job.attempts, error: job.last_error, nextAt: job.next_at } : null });
    let summary = null;
    try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch { summary = null; }
    return h.reply(request, { text: row.text, partsDone: Number(row.parts_done), partsTotal: Number(row.parts_total), summary, updatedAt: new Date(Number(row.updated_at) * 1000).toISOString(), automatic: job ? { attempts: job.attempts, error: job.last_error, nextAt: job.next_at } : null });
  }

  /** התמלול המלא של התוכנית, או null כשהוא עוד לא הושלם. */
  const finishedTranscript = async (episodeId: string) => {
    const row = await env.DB.prepare("SELECT text,parts_done,parts_total FROM program_transcripts WHERE episode_id=?").bind(episodeId)
      .first<{ text: string; parts_done: number; parts_total: number }>();
    return !row || !Number(row.parts_total) || Number(row.parts_done) < Number(row.parts_total) || !row.text.trim() ? null : row.text;
  };
  const notTranscribed = () => h.reply(request, { error: "צריך קודם להשלים את התמלול של התוכנית." }, 409);

  if (path === "/ai/summarize" && request.method === "POST") {
    const { episodeId: raw } = await body<{ episodeId?: string }>();
    const episodeId = h.safeId(raw);
    const text = await finishedTranscript(episodeId);
    if (!text) return notTranscribed();
    const useClaude = !!env.ANTHROPIC_API_KEY;
    if (!useClaude && !env.AI) return h.reply(request, { error: "שירות הבינה המלאכותית אינו מחובר לוורקר." }, 503);
    let parsed: EpisodeSummary | null = null;
    try {
      parsed = parseSummary(useClaude ? await summarizeWithClaude(env, text) : await summarizeWithWorkersAi(env, text));
    } catch (error) {
      console.error("program summarize error", episodeId, error);
      return h.reply(request, { error: "יצירת התיאור נכשלה בשירות הבינה המלאכותית. נסו שוב בעוד רגע." }, 502);
    }
    if (!parsed) return h.reply(request, { error: "שירות הבינה המלאכותית החזיר תשובה שאי אפשר לקרוא. נסו שוב." }, 502);
    const stored = { ...parsed, model: useClaude ? CLAUDE_MODEL : LLAMA_MODEL, createdAt: new Date().toISOString() };
    await env.DB.prepare("UPDATE program_transcripts SET summary_json=?,updated_at=unixepoch() WHERE episode_id=?").bind(JSON.stringify(stored), episodeId).run();
    return h.reply(request, stored);
  }
  if (path === "/ai/titles" && request.method === "POST") {
    const { episodeId: raw } = await body<{ episodeId?: string }>();
    const episodeId = h.safeId(raw);
    const text = await finishedTranscript(episodeId);
    if (!text) return notTranscribed();
    const useClaude = !!env.ANTHROPIC_API_KEY;
    if (!useClaude && !env.AI) return h.reply(request, { error: "שירות הבינה המלאכותית אינו מחובר לוורקר." }, 503);
    let parsed: TitleSuggestions | null = null;
    try {
      parsed = parseTitles(useClaude
        ? await askClaude(env, TITLES_SYSTEM, `התמלול:\n\n${text.slice(0, CLAUDE_CHARS)}`, 2000)
        : await askWorkersAi(env, TITLES_SYSTEM, `התמלול:\n\n${text.slice(0, LLAMA_CHARS)}`, 1024));
    } catch (error) {
      console.error("program titles error", episodeId, error);
      return h.reply(request, { error: "יצירת ההצעות לשם נכשלה בשירות הבינה המלאכותית. נסו שוב בעוד רגע." }, 502);
    }
    if (!parsed) return h.reply(request, { error: "שירות הבינה המלאכותית החזיר תשובה שאי אפשר לקרוא. נסו שוב." }, 502);
    return h.reply(request, parsed);
  }
  if (path === "/ai/proofread" && request.method === "POST") {
    const input = await body<{ items?: unknown }>();
    const items = validateProofreadItems(input.items);
    if (!items) return h.reply(request, { error: `צריך לשלוח בין 1 ל־${PROOFREAD_MAX_ITEMS} טקסטים עם מפתח שונה לכל אחד, ועד ${PROOFREAD_MAX_CHARS.toLocaleString("en-US")} תווים בסך הכול.` }, 400);
    const useClaude = !!env.ANTHROPIC_API_KEY;
    if (!useClaude && !env.AI) return h.reply(request, { error: "שירות הבינה המלאכותית אינו מחובר לוורקר." }, 503);
    const content = `הפריטים להגהה:\n\n${JSON.stringify(items)}`;
    let fixes: Array<{ key: string; fixed: string }> | null = null;
    let claudeError: unknown;
    try {
      if (useClaude) {
        try { fixes = parseProofread(await askClaude(env, PROOFREAD_SYSTEM, content, 8192)); }
        catch (error) { claudeError = error; console.error("program proofread Claude error", error); }
      }
      if (!fixes && env.AI) fixes = parseProofread(await askWorkersAi(env, PROOFREAD_SYSTEM, content, 4096));
    } catch (error) {
      console.error("program proofread Workers AI error", error);
      return h.reply(request, { error: "בדיקת האיכות נכשלה גם בשירות הגיבוי. נסו שוב בעוד רגע." }, 502);
    }
    if (claudeError && !fixes && !env.AI) {
      const reason = String(claudeError instanceof Error ? claudeError.message : claudeError);
      const message = /anthropic 401|anthropic 403/.test(reason) ? "מפתח Claude אינו תקין או שאין לו הרשאה. יש לבדוק את הגדרת ANTHROPIC_API_KEY."
        : /anthropic 402/.test(reason) ? "נגמרה המכסה בחשבון Claude. יש לבדוק את החשבון או לחבר את Workers AI."
        : /anthropic 429/.test(reason) ? "Claude הגביל את מספר הבקשות. נסו שוב בעוד כמה דקות."
        : "שירות Claude אינו זמין כרגע. נסו שוב בעוד רגע.";
      return h.reply(request, { error: message }, 502);
    }
    if (!fixes) return h.reply(request, { error: "שירות הבינה המלאכותית החזיר תשובה שאי אפשר לקרוא. נסו שוב." }, 502);
    return h.reply(request, { results: proofreadResults(items, fixes) });
  }
  return null;
}
