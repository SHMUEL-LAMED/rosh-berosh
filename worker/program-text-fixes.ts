/* תיקון חד־פעמי של שגיאות כתיב בשמות ובתיאורים של התוכניות שכבר שמורות ב־D1.
   כל תיקון חל רק אם השדה עדיין זהה בדיוק למקור — כך תיקון שמנהל כבר עשה
   בעצמו (או כל עריכה אחרת) לא נדרס. גם הטיוטה המשותפת מתוקנת באותו אופן,
   כדי שפרסום של טיוטה ישנה לא יחזיר את השגיאות. סימון ב־program_settings
   מבטיח שזה רץ פעם אחת בלבד. */
import fixes from "./program-text-fixes.json";

type Env = { DB: D1Database };
export type TextFix = { id: string; field: "title" | "description"; from: string; to: string };
export const TEXT_FIXES_KEY = "program-text-fixes-v1";

/** מחיל את התיקונים על רשימת תוכניות (בזיכרון); מחזיר כמה שדות שונו */
export function applyTextFixes(episodes: Array<Record<string, unknown>>, list: TextFix[] = fixes as TextFix[]): number {
  const byId = new Map(episodes.map((e) => [String(e.id), e]));
  let changed = 0;
  for (const fix of list) {
    const ep = byId.get(fix.id);
    if (ep && ep[fix.field] === fix.from) { ep[fix.field] = fix.to; changed++; }
  }
  return changed;
}

export async function runTextFixes(env: Env, list: TextFix[] = fixes as TextFix[]): Promise<number> {
  if (!list.length) return 0;
  const done = await env.DB.prepare("SELECT 1 AS done FROM program_settings WHERE key=? LIMIT 1").bind(TEXT_FIXES_KEY).first();
  if (done) return 0;
  const ids = [...new Set(list.map((f) => f.id))];
  const rows = (await env.DB.prepare(`SELECT id,data_json FROM program_episodes WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string; data_json: string }>()).results;
  const statements: D1PreparedStatement[] = [];
  let changed = 0;
  for (const row of rows) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data_json); } catch { continue; }
    data.id = row.id;
    const n = applyTextFixes([data], list);
    if (!n) continue;
    changed += n;
    statements.push(env.DB.prepare("UPDATE program_episodes SET data_json=?,updated_at=unixepoch() WHERE id=?").bind(JSON.stringify(data), row.id));
  }
  // הטיוטה המשותפת (אם יש)
  const draftRow = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key='draft'").first<{ value_json: string }>();
  if (draftRow) {
    try {
      const draft = JSON.parse(draftRow.value_json);
      if (Array.isArray(draft?.data?.episodes) && applyTextFixes(draft.data.episodes, list)) {
        statements.push(env.DB.prepare("UPDATE program_settings SET value_json=? WHERE key='draft'").bind(JSON.stringify(draft)));
      }
    } catch { /* טיוטה פגומה — לא נוגעים */ }
  }
  statements.push(env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(key) DO NOTHING")
    .bind(TEXT_FIXES_KEY, JSON.stringify({ changed, at: new Date().toISOString() })));
  await env.DB.batch(statements);
  return changed;
}
