import systemPrompts from "../ivr-service/src/ivr-system-prompts.json";

export type IvrPrompt = {
  key: string;
  label: string;
  audioUrl: string;
  yemotPath: string;
  updatedAt: number;
};

type PromptEnv = { DB: D1Database; MEDIA: R2Bucket; YEMOT_TOKEN?: string; YEMOT_API_BASE?: string };

const CONFIG_KEY = "ivr-prompts/config.json";
const RECORDERS_KEY = "ivr-prompts/recorders.json";
const PROMPTS_MIGRATED_KEY = "ivr-prompts-migrated";
const RECORDERS_MIGRATED_KEY = "ivr-recorders-migrated";

export const SYSTEM_PROMPTS = systemPrompts.map(({ key, label }) => [key, label] as const);

async function legacyJson(env: Pick<PromptEnv, "MEDIA">, key: string): Promise<unknown> {
  const object = await env.MEDIA.get(key);
  if (!object) return null;
  try { return await object.json<unknown>(); }
  catch { return null; }
}

async function migrateLegacyRecorders(env: Pick<PromptEnv, "DB" | "MEDIA">): Promise<void> {
  const migrated = await env.DB.prepare("SELECT value FROM ivr_store_meta WHERE key=?").bind(RECORDERS_MIGRATED_KEY).first();
  if (migrated) return;
  const legacy = await legacyJson(env, RECORDERS_KEY);
  const recorders = Array.isArray(legacy) ? legacy.filter((item): item is string => typeof item === "string") : [];
  await env.DB.batch([
    ...[...new Set(recorders)].map((phone) => env.DB.prepare("INSERT OR IGNORE INTO ivr_recorders (phone) VALUES (?)").bind(phone)),
    env.DB.prepare("INSERT OR REPLACE INTO ivr_store_meta (key,value) VALUES (?,?)").bind(RECORDERS_MIGRATED_KEY, "1"),
  ]);
}

async function migrateLegacyPrompts(env: Pick<PromptEnv, "DB" | "MEDIA">): Promise<void> {
  const migrated = await env.DB.prepare("SELECT value FROM ivr_store_meta WHERE key=?").bind(PROMPTS_MIGRATED_KEY).first();
  if (migrated) return;
  const legacy = await legacyJson(env, CONFIG_KEY);
  const prompts = Array.isArray(legacy) ? legacy.filter(isPrompt) : [];
  await env.DB.batch([
    ...prompts.map((prompt) => env.DB.prepare("INSERT OR IGNORE INTO ivr_prompts (key,label,audio_url,yemot_path,updated_at) VALUES (?,?,?,?,?)").bind(prompt.key, prompt.label, prompt.audioUrl, prompt.yemotPath, prompt.updatedAt)),
    env.DB.prepare("INSERT OR REPLACE INTO ivr_store_meta (key,value) VALUES (?,?)").bind(PROMPTS_MIGRATED_KEY, "1"),
  ]);
}

export async function readIvrRecorders(env: Pick<PromptEnv, "DB" | "MEDIA">): Promise<string[]> {
  await migrateLegacyRecorders(env);
  const rows = await env.DB.prepare("SELECT phone FROM ivr_recorders ORDER BY phone").all<{ phone: string }>();
  return rows.results.map((row) => row.phone);
}

export async function addIvrRecorder(env: Pick<PromptEnv, "DB" | "MEDIA">, phone: string): Promise<string[]> {
  await migrateLegacyRecorders(env);
  await env.DB.prepare("INSERT OR IGNORE INTO ivr_recorders (phone) VALUES (?)").bind(phone).run();
  return readIvrRecorders(env);
}

export async function removeIvrRecorder(env: Pick<PromptEnv, "DB" | "MEDIA">, phone: string): Promise<{ removed: boolean; reason?: "missing" | "last"; recorders: string[] }> {
  await migrateLegacyRecorders(env);
  const removed = await env.DB.prepare("DELETE FROM ivr_recorders WHERE phone=? AND (SELECT COUNT(*) FROM ivr_recorders)>1 RETURNING phone").bind(phone).first<{ phone: string }>();
  if (removed) return { removed: true, recorders: await readIvrRecorders(env) };
  const exists = await env.DB.prepare("SELECT phone FROM ivr_recorders WHERE phone=?").bind(phone).first();
  return { removed: false, reason: exists ? "last" : "missing", recorders: await readIvrRecorders(env) };
}

export async function readIvrPrompts(env: Pick<PromptEnv, "DB" | "MEDIA">): Promise<IvrPrompt[]> {
  await migrateLegacyPrompts(env);
  const rows = await env.DB.prepare("SELECT key,label,audio_url AS audioUrl,yemot_path AS yemotPath,updated_at AS updatedAt FROM ivr_prompts ORDER BY key").all<IvrPrompt>();
  return rows.results;
}

export async function upsertIvrPrompt(env: Pick<PromptEnv, "DB" | "MEDIA">, prompt: IvrPrompt): Promise<void> {
  await migrateLegacyPrompts(env);
  await env.DB.prepare("INSERT INTO ivr_prompts (key,label,audio_url,yemot_path,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label,audio_url=excluded.audio_url,yemot_path=excluded.yemot_path,updated_at=excluded.updated_at")
    .bind(prompt.key, prompt.label, prompt.audioUrl, prompt.yemotPath, prompt.updatedAt).run();
}

export async function deleteIvrPrompt(env: Pick<PromptEnv, "DB" | "MEDIA">, key: string): Promise<void> {
  await migrateLegacyPrompts(env);
  await env.DB.prepare("DELETE FROM ivr_prompts WHERE key=?").bind(key).run();
}

export async function deleteIvrAudioIfUnreferenced(env: Pick<PromptEnv, "DB" | "MEDIA">, audioUrl?: string): Promise<void> {
  if (!audioUrl?.startsWith("/media/")) return;
  const referenced = await env.DB.prepare("SELECT COUNT(*) AS total FROM ivr_prompts WHERE audio_url=?").bind(audioUrl).first<{ total: number }>();
  if (Number(referenced?.total || 0)) return;
  await env.MEDIA.delete(decodeURIComponent(audioUrl.slice(7)));
}

export async function syncPromptToYemot(env: PromptEnv, key: string, file: File): Promise<{ path: string; warning?: string }> {
  if (!env.YEMOT_TOKEN) return { path: "", warning: "קובץ הקריינות נשמר, אך חסר YEMOT_TOKEN כדי להעביר אותו לקו." };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const short = [...new Uint8Array(digest)].slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Yemot rejects punctuation in file-message paths, so keep this identifier
  // strictly alphanumeric.
  const fileName = `rb${short}`;
  const target = `ivr2:/${fileName}.wav`;
  const base = (env.YEMOT_API_BASE || "https://www.call2all.co.il/ym/api").replace(/\/$/, "");
  const url = new URL(`${base}/UploadFile`);
  url.searchParams.set("token", env.YEMOT_TOKEN);
  url.searchParams.set("path", target);
  url.searchParams.set("convertAudio", "1");
  url.searchParams.set("autoNumbering", "false");
  const form = new FormData();
  form.set("upload", file, file.name || `${fileName}.wav`);
  try {
    const response = await fetch(url, { method: "POST", body: form });
    const raw = await response.text();
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(raw) as Record<string, unknown>; } catch {}
    const failed = !response.ok || result.responseStatus === "ERROR" || result.responseStatus === "EXCEPTION" || result.response === false;
    if (failed) return { path: "", warning: `הקובץ נשמר באתר, אך ההעברה לימות המשיח נכשלה: ${String(result.message || result.messageCode || response.status)}` };
    return { path: `/${fileName}` };
  } catch {
    return { path: "", warning: "הקובץ נשמר באתר, אך כרגע לא ניתן היה להעביר אותו לימות המשיח." };
  }
}

function isPrompt(value: unknown): value is IvrPrompt {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && typeof item.label === "string" && typeof item.audioUrl === "string" && typeof item.yemotPath === "string" && typeof item.updatedAt === "number";
}
