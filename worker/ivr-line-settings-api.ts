/** הגדרות הקו הטלפוני מהאתר: נתיב ניהול לאתר ונתיב קריאה לשירות הקו. הלוגיקה והבדיקות ב-`ivr-line-settings.js`. */
import { readSession } from "./auth";
import { ensureIvrSchema } from "./schema";
import { describeLineSettings, emptyLineSettings, LINE_SETTINGS_KEY, lineSettingsForIvr, parseStoredLineSettings, validateLineSettings } from "./ivr-line-settings.js";

type LineSettingsEnv = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type StoredLineSettings = ReturnType<typeof emptyLineSettings>;
type StoredRow = { settings: StoredLineSettings; updatedAt: number | null; updatedBy: string | null };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const ADMIN_LINE_SETTINGS_PATH = "/api/admin/ivr-line-settings";
export const IVR_LINE_SETTINGS_PATH = "/api/ivr/line-settings";

function isMissingTable(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}

// נתיב הקו אינו מריץ את בניית הסכמה המלאה (ראו index.ts). טבלה חסרה פירושה
// שעדיין לא נשמרה הגדרה, ולכן הקריאה מחזירה "לא נקבע" במקום שגיאה.
async function readStored(env: Pick<LineSettingsEnv, "DB">): Promise<StoredRow> {
  try {
    const row = await env.DB.prepare("SELECT value FROM ivr_store_meta WHERE key=?").bind(LINE_SETTINGS_KEY).first<{ value: string }>();
    return parseStoredLineSettings(row?.value ?? null) as StoredRow;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return { settings: emptyLineSettings(), updatedAt: null, updatedBy: null };
  }
}

async function writeStored(env: Pick<LineSettingsEnv, "DB">, settings: StoredLineSettings, updatedBy: string): Promise<StoredRow> {
  const updatedAt = Math.floor(Date.now() / 1000);
  const value = JSON.stringify({ ...settings, updatedAt, updatedBy });
  const write = () => env.DB.prepare("INSERT OR REPLACE INTO ivr_store_meta (key,value) VALUES (?,?)").bind(LINE_SETTINGS_KEY, value).run();
  try { await write(); }
  catch (error) {
    if (!isMissingTable(error)) throw error;
    await ensureIvrSchema(env);
    await write();
  }
  return { settings, updatedAt, updatedBy };
}

function adminView(stored: StoredRow) {
  return { ok: true, ...describeLineSettings(stored.settings), updatedAt: stored.updatedAt, updatedBy: stored.updatedBy };
}

/** GET/POST `/api/admin/ivr-line-settings` — מנהלי האתר בלבד. מחזיר null לכל נתיב אחר. */
export async function lineSettingsAdminApi(request: Request, env: LineSettingsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ADMIN_LINE_SETTINGS_PATH) return null;
  const user = await readSession(request, env);
  if (!user?.isAdmin) return json({ error: "אין הרשאת מנהל." }, 403);
  try {
    if (request.method === "GET") return json(adminView(await readStored(env)));
    if (request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); }
      catch { return json({ error: "פרטי ההגדרות אינם תקינים." }, 400); }
      const current = await readStored(env);
      const result = validateLineSettings(body, current.settings) as { settings?: StoredLineSettings; error?: string };
      if (result.error || !result.settings) return json({ error: result.error || "פרטי ההגדרות אינם תקינים." }, 400);
      return json(adminView(await writeStored(env, result.settings, user.email)));
    }
    return json({ error: "הפעולה אינה נתמכת." }, 405);
  } catch (error) {
    console.error("ivr line settings admin error", error);
    return json({ error: "לא ניתן לשמור כרגע את הגדרות הקו." }, 500);
  }
}

/**
 * GET `/api/ivr/line-settings` — לשירות הקו, אחרי בדיקת הסוד ב-index.ts. תקלת
 * מסד מחזירה 500 ולא "לא נקבע", כדי שהשירות ימשיך עם הערכים האחרונים שקיבל
 * ולא יחזור בטעות לברירות המחדל באמצע היום.
 */
export async function lineSettingsForIvrResponse(env: LineSettingsEnv): Promise<Response> {
  try {
    const stored = await readStored(env);
    return json({ settings: lineSettingsForIvr(stored.settings), updatedAt: stored.updatedAt });
  } catch (error) {
    console.error("ivr line settings read error", error);
    return json({ error: "לא ניתן לטעון את הגדרות הקו." }, 500);
  }
}
