/** ניהול רשימת התפוצה. מודול נפרד מ-`admin.ts` כי הוא עומד בפני עצמו: טבלה אחת, בלי תלות בסקר הפעיל ובלי נגיעה בקטלוג. */
import { readSession } from "./auth";
import { ensureRuntimeSchema } from "./schema";
import { isValidEmail, normalizeEmail, normalizeName, parseSubscriberList } from "./subscribers.js";

type SubscribersEnv = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status });

export type ImportResult = { found: number; added: number; duplicates: number; optedOut: number; skipped: number };

/**
 * ייבוא כתובות לרשימה — מדף הניהול (כאן) ומעורך טיוטת המייל באתר התוכניות
 * (`POST /api/program/subscribers`). כתובת שכבר ברשימה לא משתנה, ומי שהסיר את
 * עצמו בעבר *לא* חוזר לרשימה: ההסרה שלו גוברת על ייבוא. מחזיר null כשאין בתוכן
 * אף כתובת תקינה.
 */
export async function importSubscribers(db: D1Database, content: unknown): Promise<ImportResult | null> {
  const { entries, skipped } = parseSubscriberList(content);
  if (!entries.length) return null;
  const before = await db.prepare("SELECT COUNT(*) AS total FROM subscribers").first<{ total: number }>();
  // D1 מגביל את גודל ה-batch, ולכן הייבוא רץ במנות. מנה שנכשלת אינה
  // עוצרת את השאר — הדיווח בסוף מבוסס על ספירה אמיתית ולא על הערכה.
  const CHUNK = 50;
  let optedOut = 0;
  for (let index = 0; index < entries.length; index += CHUNK) {
    const part = entries.slice(index, index + CHUNK);
    const chunk = part.map((entry) => db.prepare(`
      INSERT INTO subscribers (id, email, name, source, consented_at)
      VALUES (?, ?, ?, 'import', unixepoch())
      ON CONFLICT(email) DO UPDATE SET
        name = CASE WHEN excluded.name != '' AND COALESCE(subscribers.name,'') = '' THEN excluded.name ELSE subscribers.name END
    `).bind(crypto.randomUUID(), entry.email, entry.name));
    try { await db.batch(chunk); }
    catch (error) { console.error("subscriber import chunk error", error); }
    const gone = await db.prepare(`SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NOT NULL AND email IN (${part.map(() => "?").join(",")})`).bind(...part.map((entry) => entry.email)).first<{ n: number }>();
    optedOut += Number(gone?.n || 0);
  }
  const after = await db.prepare("SELECT COUNT(*) AS total FROM subscribers").first<{ total: number }>();
  const added = Number(after?.total || 0) - Number(before?.total || 0);
  return { found: entries.length, added, duplicates: entries.length - added - optedOut, optedOut, skipped };
}

/** מחזיר null כשהנתיב אינו שייך למודול, כדי ש-`index.ts` ימשיך לנתב הלאה. */
export async function subscribersAdminApi(request: Request, env: SubscribersEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/subscribers" && url.pathname !== "/api/admin/subscribers/import" && url.pathname !== "/api/admin/subscribers/handled") return null;

  const user = await readSession(request, env);
  if (!user?.isAdmin) return json({ error: "אין הרשאת מנהל." }, 403);
  await ensureRuntimeSchema(env);
  const surveyId = (await env.DB.prepare("SELECT id FROM surveys WHERE active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())?.id ?? "main";

  if (request.method === "GET" && url.pathname === "/api/admin/subscribers") {
    const query = normalizeEmail(url.searchParams.get("q") || "");
    const includeRemoved = url.searchParams.get("removed") === "1";
    const where: string[] = [];
    const binds: unknown[] = [];
    if (!includeRemoved) where.push("unsubscribed_at IS NULL");
    if (query) { where.push("(LOWER(email) LIKE ? OR LOWER(COALESCE(name,'')) LIKE ?)"); binds.push(`%${query}%`, `%${query}%`); }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // הרשימה נטענת במלואה: גם כמה אלפי נמענים הם מטען קטן, וכך החיפוש
    // והייצוא בדף הניהול עובדים על אותו מקור בלי עימוד.
    const rows = await env.DB.prepare(`SELECT id, email, name, source, survey_id AS surveyId, consented_at AS consentedAt, unsubscribed_at AS unsubscribedAt, handled_at AS handledAt, created_at AS createdAt FROM subscribers ${filter} ORDER BY created_at DESC LIMIT 20000`).bind(...binds).all();
    const totals = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN unsubscribed_at IS NULL THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN unsubscribed_at IS NULL AND handled_at IS NULL THEN 1 ELSE 0 END) AS fresh FROM subscribers").first<{ total: number; active: number; fresh: number }>();
    return json({ subscribers: rows.results, total: Number(totals?.total || 0), active: Number(totals?.active || 0), fresh: Number(totals?.fresh || 0) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/subscribers") {
    const body = await request.json<{ email?: string; name?: string }>();
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return json({ error: "כתובת הדוא״ל אינה תקינה." }, 400);
    await env.DB.prepare(`
      INSERT INTO subscribers (id, email, name, source, survey_id, consented_at)
      VALUES (?, ?, ?, 'admin', ?, unixepoch())
      ON CONFLICT(email) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE subscribers.name END,
        unsubscribed_at = NULL
    `).bind(crypto.randomUUID(), email, normalizeName(body.name), surveyId).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/subscribers/import") {
    const body = await request.json<{ content?: string }>();
    const result = await importSubscribers(env.DB, body.content);
    if (!result) return json({ error: "לא נמצאה אף כתובת דוא״ל תקינה בקובץ." }, 400);
    return json({ ok: true, ...result });
  }

  /* „חדשים” ו„טופלו”: מי שכבר הועבר לרשימה אחרת מסומן כטופל, וכך רואים מי הצטרף מאז.
     { all: true } — כל החדשים עכשיו (רק מי שכבר ברשימה כשלחצו; מי שיצטרף אחר כך יהיה חדש),
     { emails: [...] } — כתובות מסוימות; handled: false מחזיר אותן ל„חדשים”. */
  if (request.method === "POST" && url.pathname === "/api/admin/subscribers/handled") {
    const body = await request.json<{ all?: boolean; emails?: unknown; handled?: boolean; before?: number }>().catch(() => null);
    if (!body) return json({ error: "בקשה לא תקינה." }, 400);
    const handled = body.handled !== false;
    if (body.all) {
      // „before” — הזמן שבו נטענה הרשימה במסך: מי שנרשם אחרי זה לא נכלל, גם אם הצטרף ברגע הלחיצה
      const before = Number.isFinite(Number(body.before)) && Number(body.before) > 0 ? Math.floor(Number(body.before)) : null;
      const result = await env.DB.prepare(`UPDATE subscribers SET handled_at=unixepoch() WHERE handled_at IS NULL AND unsubscribed_at IS NULL${before ? " AND created_at<=?" : ""} RETURNING id`).bind(...(before ? [before] : [])).all();
      return json({ ok: true, changed: result.results.length });
    }
    const emails = [...new Set((Array.isArray(body.emails) ? body.emails : []).map((email) => normalizeEmail(String(email))).filter(isValidEmail))].slice(0, 5000);
    if (!emails.length) return json({ error: "לא נבחרו כתובות." }, 400);
    let changed = 0;
    for (let index = 0; index < emails.length; index += 90) {
      const part = emails.slice(index, index + 90);
      const result = await env.DB.prepare(`UPDATE subscribers SET handled_at=${handled ? "unixepoch()" : "NULL"} WHERE email IN (${part.map(() => "?").join(",")}) RETURNING id`).bind(...part).all();
      changed += result.results.length;
    }
    return json({ ok: true, changed });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/subscribers") {
    const body = await request.json<{ email?: string; purge?: boolean }>();
    const email = normalizeEmail(body.email);
    if (!email) return json({ error: "כתובת דוא״ל חסרה." }, 400);
    // ברירת המחדל היא סימון כמוסר ולא מחיקה, כדי שיישאר תיעוד להסכמה
    // שניתנה בעבר. מחיקה מלאה נשארת אפשרית במפורש.
    if (body.purge) await env.DB.prepare("DELETE FROM subscribers WHERE email=?").bind(email).run();
    else await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=unixepoch() WHERE email=?").bind(email).run();
    return json({ ok: true });
  }

  return json({ error: "לא נמצא." }, 404);
}
