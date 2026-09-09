import { applyIvrRuntimeSchema, applyRuntimeSchema } from "./schema-statements.js";

type SchemaEnv = { DB: D1Database };

let migrated = false;
let running: Promise<void> | null = null;
let lastAttempt = 0;

// כשמשפט בבנייה נכשל (למשל אינדקס ייחודי שנתונים קיימים סותרים) הדגל נשאר
// כבוי, ובלי הבלימה הזאת כל בקשה הייתה מריצה שוב את כל עשרות המשפטים ברצף
// ומאטה את התגובה — עד כדי ניתוק הקו הטלפוני.
const RETRY_AFTER_MS = 5 * 60 * 1000;

export async function ensureRuntimeSchema(env: SchemaEnv): Promise<void> {
  if (migrated) return;
  if (running) return running;
  if (lastAttempt && Date.now() - lastAttempt < RETRY_AFTER_MS) return;
  lastAttempt = Date.now();
  running = (async () => {
    const failures = await applyRuntimeSchema(env.DB);
    for (const failure of failures) console.error("schema migration error", failure.statement, failure.error);
    migrated = failures.length === 0;
  })();
  try { await running; }
  finally { running = null; }
}

let ivrReady = false;
let ivrRunning: Promise<void> | null = null;

/**
 * בונה רק את טבלאות הקו הטלפוני. נקרא כשאחת מהן חסרה, כדי שקו הניהול לא ייפול
 * על מסד שטרם עבר את הבנייה המלאה, ובלי לשלם על כל הסכמה בזמן שיחה.
 */
export async function ensureIvrSchema(env: SchemaEnv): Promise<void> {
  if (ivrReady) return;
  if (ivrRunning) return ivrRunning;
  ivrRunning = (async () => {
    const failures = await applyIvrRuntimeSchema(env.DB);
    for (const failure of failures) console.error("ivr schema migration error", failure.statement, failure.error);
    ivrReady = failures.length === 0;
  })();
  try { await ivrRunning; }
  finally { ivrRunning = null; }
}
