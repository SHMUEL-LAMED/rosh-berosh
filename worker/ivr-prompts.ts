export type IvrPrompt = {
  key: string;
  label: string;
  audioUrl: string;
  yemotPath: string;
  updatedAt: number;
};

type PromptEnv = { MEDIA: R2Bucket; YEMOT_TOKEN?: string; YEMOT_API_BASE?: string };

const CONFIG_KEY = "ivr-prompts/config.json";

export const SYSTEM_PROMPTS = [
  ["system:main_menu", "תפריט ראשי: אלבומים 1, שירים 2, זמרים 3"],
  ["system:albums_intro", "פתיח לבחירת אלבומים"],
  ["system:albums_menu", "תפריט האלבומים המלא ברצף, כולל מספרי ההקשה"],
  ["system:songs_intro", "פתיח לבחירת שירים"],
  ["system:artists_intro", "פתיח לבחירת זמרים"],
  ["system:need_albums", "יש לבחור קודם אלבומים"],
  ["system:section_saved", "הבחירה נשמרה וחוזרים לתפריט"],
  ["system:already_voted", "כבר הצבעתם"],
  ["system:already_selected", "כבר הצבעתם לזה בחרו אפשרות אחרת"],
  ["system:finish_selection", "סיום בחירה לאחר הכמות המינימלית"],
  ["system:voting_closed", "ההצבעה עדיין אינה פתוחה"],
  ["system:not_ready", "רשימות המצעד עדיין אינן מוכנות"],
  ["system:error", "אירעה שגיאה"],
  ["system:success", "ההצבעה נקלטה בהצלחה"],
] as const;

export async function readIvrPrompts(env: Pick<PromptEnv, "MEDIA">): Promise<IvrPrompt[]> {
  const object = await env.MEDIA.get(CONFIG_KEY);
  if (!object) return [];
  try {
    const value = await object.json<unknown>();
    if (!Array.isArray(value)) return [];
    return value.filter(isPrompt);
  } catch {
    return [];
  }
}

export async function saveIvrPrompts(env: Pick<PromptEnv, "MEDIA">, prompts: IvrPrompt[]): Promise<void> {
  await env.MEDIA.put(CONFIG_KEY, JSON.stringify(prompts), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
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
