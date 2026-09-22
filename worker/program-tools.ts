/* כלי הניהול של אתר התוכניות (Ringtones), מעבר לקטלוג עצמו:
   הגדרות האתר (הודעה בדף הבית, דף עדכונים), טיוטה משותפת בין מכשירים,
   קישור תצוגה מקדימה, גרסאות שנשמרות אוטומטית בכל פרסום, אירועי האזנה
   לסטטיסטיקה, הודעות מהמאזינים, רשימת המנהלים (אותה רשימה של אתר הסקר)
   ורשימת התפוצה (אותה טבלה של אתר הסקר, עם חשבון Google המחובר). */
import { readAdminEmails, readSession, saveAdminEmails, type SessionUser } from "./auth";
import { checkBallotRate } from "./rate-limit";
import { isValidEmail, normalizeEmail, normalizeName } from "./subscribers.js";

type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type Helpers = {
  reply: (request: Request, body: unknown, status?: number) => Response;
  admin: (request: Request, env: Env) => Promise<SessionUser | null>;
  safeId: (value: unknown) => string;
};

export const PUBLIC_SETTING_KEYS = ["banner", "updates"] as const;
export const VERSIONS_KEPT = 40;
const MAX_TEXT = 4000;
const DAY_SECONDS = 86400;

const text = (value: unknown, max = 300) => String(value ?? "").trim().slice(0, max);
const day = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readSetting<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key=?").bind(key).first<{ value_json: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value_json) as T; } catch { return null; }
}

export function settingStatement(env: Env, key: string, value: unknown) {
  return env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=unixepoch()").bind(key, JSON.stringify(value));
}

/** ההודעה בדף הבית: טקסט, קישור, ועד מתי. שדות לא מוכרים נזרקים. */
export function normalizeBanner(raw: unknown) {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const message = text(b.text, 300);
  return { enabled: !!b.enabled && !!message, text: message, link: text(b.link, 500), linkLabel: text(b.linkLabel, 80), until: /^\d{4}-\d{2}-\d{2}/.test(String(b.until || "")) ? String(b.until).slice(0, 10) : "" };
}

/** דף העדכונים: הודעות קצרות עם תאריך. הפריטים נשמרים מהחדש לישן. */
export function normalizeUpdates(raw: unknown) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 200).map((item) => {
    const u = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return { id: text(u.id, 40) || crypto.randomUUID(), date: /^\d{4}-\d{2}-\d{2}/.test(String(u.date || "")) ? String(u.date).slice(0, 10) : day(), title: text(u.title, 160), text: text(u.text, MAX_TEXT), link: text(u.link, 500), pinned: !!u.pinned };
  }).filter((u) => u.title || u.text).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date));
}

/** מה מתפרסם לציבור יחד עם הקטלוג. */
export async function publicSettings(env: Env) {
  const rows = await env.DB.prepare("SELECT key,value_json FROM program_settings WHERE key IN ('banner','updates')").all<{ key: string; value_json: string }>();
  const values = new Map(rows.results.map((row) => { try { return [row.key, JSON.parse(row.value_json)]; } catch { return [row.key, null]; } }));
  return { banner: normalizeBanner(values.get("banner")), updates: normalizeUpdates(values.get("updates")) };
}

/** משפטי הכתיבה של ההגדרות שהגיעו עם פרסום הקטלוג. */
export function settingsStatements(env: Env, raw: unknown) {
  const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const statements = [];
  if ("banner" in settings) statements.push(settingStatement(env, "banner", normalizeBanner(settings.banner)));
  if ("updates" in settings) statements.push(settingStatement(env, "updates", normalizeUpdates(settings.updates)));
  return statements;
}

/** גרסה נשמרת אוטומטית בכל פרסום; רק האחרונות נשארות. */
export function versionStatements(env: Env, by: string, snapshot: { seasons: unknown[]; episodes: unknown[]; settings?: unknown }) {
  const id = crypto.randomUUID();
  return [
    env.DB.prepare("INSERT INTO program_versions (id,by_email,episodes,data_json) VALUES (?,?,?,?)").bind(id, by, snapshot.episodes.length, JSON.stringify(snapshot)),
    env.DB.prepare(`DELETE FROM program_versions WHERE id NOT IN (SELECT id FROM program_versions ORDER BY created_at DESC, rowid DESC LIMIT ${VERSIONS_KEPT})`),
  ];
}

export async function programToolsApi(request: Request, env: Env, h: Helpers): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/program".length);
  const method = request.method;
  const body = async <T>() => { try { return await request.json<T>(); } catch { return {} as T; } };
  const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
  const tooMany = () => h.reply(request, { error: "יותר מדי בקשות. נסו שוב בעוד דקה." }, 429);
  const forbidden = () => h.reply(request, { error: "אין הרשאת ניהול." }, 403);

  /* ---------- טיוטה משותפת ---------- */
  if (path === "/draft") {
    const user = await h.admin(request, env);
    if (!user) return forbidden();
    if (method === "GET") {
      const draft = await readSetting<{ data: unknown; updatedAt: string; by: string }>(env, "draft");
      return h.reply(request, { draft: draft || null });
    }
    if (method === "PUT") {
      const { data } = await body<{ data?: { seasons?: unknown[]; episodes?: unknown[] } }>();
      if (!data || !Array.isArray(data.episodes) || !Array.isArray(data.seasons) || data.episodes.length > 2000) return h.reply(request, { error: "הטיוטה אינה תקינה." }, 400);
      const draft = { data, updatedAt: new Date().toISOString(), by: user.email };
      await settingStatement(env, "draft", draft).run();
      return h.reply(request, { ok: true, updatedAt: draft.updatedAt, by: draft.by });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM program_settings WHERE key='draft'").run();
      return h.reply(request, { ok: true });
    }
  }

  /* ---------- קישור תצוגה מקדימה לטיוטה ---------- */
  if (path === "/preview") {
    const user = await h.admin(request, env);
    if (!user) return forbidden();
    if (method === "GET") return h.reply(request, { preview: await readSetting(env, "preview") });
    if (method === "POST") {
      const preview = { token: crypto.randomUUID().replace(/-/g, ""), createdAt: new Date().toISOString(), by: user.email };
      await settingStatement(env, "preview", preview).run();
      return h.reply(request, { ok: true, preview });
    }
    if (method === "DELETE") { await env.DB.prepare("DELETE FROM program_settings WHERE key='preview'").run(); return h.reply(request, { ok: true }); }
  }
  if (path.startsWith("/preview/") && method === "GET") {
    const token = path.slice("/preview/".length);
    const preview = await readSetting<{ token: string }>(env, "preview");
    if (!token || !preview || preview.token !== token) return h.reply(request, { error: "קישור התצוגה המקדימה אינו בתוקף." }, 404);
    const draft = await readSetting<{ data: unknown; updatedAt: string }>(env, "draft");
    if (!draft) return h.reply(request, { error: "אין טיוטה כרגע." }, 404);
    return h.reply(request, { data: draft.data, updatedAt: draft.updatedAt });
  }

  /* ---------- גרסאות (גיבוי אוטומטי בכל פרסום) ---------- */
  if (path === "/versions" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const rows = await env.DB.prepare(`SELECT id, by_email AS by, episodes, created_at AS createdAt FROM program_versions ORDER BY created_at DESC, rowid DESC LIMIT ${VERSIONS_KEPT}`).all();
    return h.reply(request, { versions: rows.results });
  }
  if (path.startsWith("/versions/") && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const row = await env.DB.prepare("SELECT data_json AS data, by_email AS by, created_at AS createdAt FROM program_versions WHERE id=?").bind(h.safeId(path.slice("/versions/".length))).first<{ data: string; by: string; createdAt: number }>();
    if (!row) return h.reply(request, { error: "הגרסה לא נמצאה." }, 404);
    try { return h.reply(request, { data: JSON.parse(row.data), by: row.by, createdAt: row.createdAt }); }
    catch { return h.reply(request, { error: "הגרסה פגומה." }, 500); }
  }

  /* ---------- אירועי האזנה (ציבורי, מוגבל בקצב) ---------- */
  if (path === "/events" && method === "POST") {
    if (!(await checkBallotRate(env.DB, `pevent:${clientIp}`))) return tooMany();
    const event = await body<{ kind?: string; episodeId?: string; seconds?: number; device?: string }>();
    const kind = event.kind === "listen" ? "listen" : "play";
    const episodeId = h.safeId(event.episodeId);
    if (!episodeId) return h.reply(request, { error: "חסר מזהה תוכנית." }, 400);
    const seconds = Math.min(600, Math.max(0, Math.floor(Number(event.seconds) || 0)));
    const device = event.device === "phone" ? "phone" : "desktop";
    const client = await hash(`${clientIp}|${request.headers.get("user-agent") || ""}|${day()}`);
    await env.DB.prepare("INSERT INTO program_events (episode_id,kind,seconds,device,day,client_hash) VALUES (?,?,?,?,?,?)").bind(episodeId, kind, seconds, device, day(), client).run();
    return h.reply(request, { ok: true });
  }

  /* ---------- סטטיסטיקות (מנהל) ---------- */
  if (path === "/stats" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const since30 = nowSeconds() - 30 * DAY_SECONDS, since7 = nowSeconds() - 7 * DAY_SECONDS;
    const [days, episodes, recent, totals, devices, week] = await env.DB.batch([
      env.DB.prepare("SELECT day, SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners, SUM(seconds) AS seconds FROM program_events WHERE created_at>=? GROUP BY day ORDER BY day").bind(since30),
      env.DB.prepare("SELECT episode_id AS id, SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners, SUM(seconds) AS seconds FROM program_events GROUP BY episode_id ORDER BY plays DESC LIMIT 300"),
      env.DB.prepare("SELECT episode_id AS id, SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners, SUM(seconds) AS seconds FROM program_events WHERE created_at>=? GROUP BY episode_id ORDER BY plays DESC LIMIT 300").bind(since30),
      env.DB.prepare("SELECT SUM(kind='play') AS plays, COUNT(DISTINCT client_hash || day) AS listeners, SUM(seconds) AS seconds FROM program_events"),
      env.DB.prepare("SELECT device, SUM(kind='play') AS plays FROM program_events WHERE created_at>=? GROUP BY device").bind(since30),
      env.DB.prepare("SELECT SUM(kind='play') AS plays, COUNT(DISTINCT client_hash || day) AS listeners FROM program_events WHERE created_at>=?").bind(since7),
    ]);
    const deviceMap: Record<string, number> = {};
    for (const row of devices.results as Array<{ device: string; plays: number }>) deviceMap[row.device] = Number(row.plays) || 0;
    return h.reply(request, { days: days.results, episodes: episodes.results, recent: recent.results, totals: totals.results[0] || {}, week: week.results[0] || {}, devices: deviceMap });
  }

  /* ---------- הודעות מהמאזינים ---------- */
  if (path === "/messages" && method === "POST") {
    if (!(await checkBallotRate(env.DB, `pmsg:${clientIp}`))) return tooMany();
    const message = await body<{ name?: string; email?: string; text?: string; episodeId?: string }>();
    const content = text(message.text, MAX_TEXT);
    if (content.length < 2) return h.reply(request, { error: "ההודעה ריקה." }, 400);
    const user = await readSession(request, env);
    const email = normalizeEmail(user?.email || message.email);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO program_messages (id,name,email,text,episode_id) VALUES (?,?,?,?,?)")
      .bind(id, normalizeName(user?.name || message.name), isValidEmail(email) ? email : "", content, h.safeId(message.episodeId) || null).run();
    return h.reply(request, { ok: true, id });
  }
  if (path === "/messages" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const rows = await env.DB.prepare("SELECT id, name, email, text, episode_id AS episodeId, read_at AS readAt, created_at AS createdAt FROM program_messages ORDER BY created_at DESC LIMIT 300").all();
    const unread = await env.DB.prepare("SELECT COUNT(*) AS unread FROM program_messages WHERE read_at IS NULL").first<{ unread: number }>();
    return h.reply(request, { messages: rows.results, unread: Number(unread?.unread || 0) });
  }
  if (path === "/messages/read" && method === "POST") {
    if (!await h.admin(request, env)) return forbidden();
    const { id, read } = await body<{ id?: string; read?: boolean }>();
    if (!h.safeId(id)) return h.reply(request, { error: "חסר מזהה." }, 400);
    await env.DB.prepare(`UPDATE program_messages SET read_at=${read === false ? "NULL" : "unixepoch()"} WHERE id=?`).bind(h.safeId(id)).run();
    return h.reply(request, { ok: true });
  }
  if (path === "/messages" && method === "DELETE") {
    if (!await h.admin(request, env)) return forbidden();
    const { id } = await body<{ id?: string }>();
    if (!h.safeId(id)) return h.reply(request, { error: "חסר מזהה." }, 400);
    await env.DB.prepare("DELETE FROM program_messages WHERE id=?").bind(h.safeId(id)).run();
    return h.reply(request, { ok: true });
  }

  /* ---------- מנהלים: אותה רשימה של אתר הסקר ---------- */
  if (path === "/admins") {
    const user = await h.admin(request, env);
    if (!user) return forbidden();
    const fixed = String(env.ADMIN_EMAILS || "").split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean);
    const list = async () => (await readAdminEmails(env)).map((email) => ({ email, fixed: fixed.includes(email), you: email === user.email }));
    if (method === "GET") return h.reply(request, { admins: await list() });
    const { email: raw } = await body<{ email?: string }>();
    const email = normalizeEmail(raw);
    if (method === "POST") {
      if (!isValidEmail(email)) return h.reply(request, { error: "כתובת הדוא״ל אינה תקינה." }, 400);
      const admins = await readAdminEmails(env);
      if (!admins.includes(email)) admins.push(email);
      await saveAdminEmails(env, admins);
      return h.reply(request, { ok: true, admins: await list() });
    }
    if (method === "DELETE") {
      if (!email) return h.reply(request, { error: "כתובת מנהל חסרה." }, 400);
      if (email === user.email) return h.reply(request, { error: "אי אפשר להסיר את החשבון שבו אתם מחוברים." }, 400);
      if (fixed.includes(email)) return h.reply(request, { error: "המנהל הזה מוגדר בהגדרות השרת ואי אפשר להסיר אותו מכאן." }, 400);
      await saveAdminEmails(env, (await readAdminEmails(env)).filter((item) => item !== email));
      return h.reply(request, { ok: true, admins: await list() });
    }
  }

  /* ---------- רשימת התפוצה: אותה טבלה של אתר הסקר, עם החשבון המחובר ---------- */
  if (path === "/subscribe") {
    const user = await readSession(request, env);
    if (!user) return h.reply(request, { error: "צריך להתחבר כדי להירשם לרשימת התפוצה." }, 401);
    const email = normalizeEmail(user.email);
    if (!isValidEmail(email)) return h.reply(request, { error: "כתובת הדוא״ל של החשבון אינה תקינה." }, 400);
    if (method === "GET") {
      const row = await env.DB.prepare("SELECT 1 AS one FROM subscribers WHERE email=? AND unsubscribed_at IS NULL").bind(email).first<{ one: number }>();
      return h.reply(request, { subscribed: !!row, email });
    }
    if (method === "POST") {
      if (!(await checkBallotRate(env.DB, `subscribe:${clientIp}`))) return tooMany();
      const surveyId = (await env.DB.prepare("SELECT id FROM surveys WHERE active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string }>().catch(() => null))?.id ?? "main";
      await env.DB.prepare(`
        INSERT INTO subscribers (id, email, name, source, survey_id, user_sub, consented_at)
        VALUES (?, ?, ?, 'program', ?, ?, unixepoch())
        ON CONFLICT(email) DO UPDATE SET
          name = CASE WHEN excluded.name != '' THEN excluded.name ELSE subscribers.name END,
          user_sub = COALESCE(excluded.user_sub, subscribers.user_sub),
          consented_at = unixepoch(),
          unsubscribed_at = NULL
      `).bind(crypto.randomUUID(), email, normalizeName(user.name), surveyId, user.sub ?? null).run();
      return h.reply(request, { ok: true, subscribed: true, email });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE subscribers SET unsubscribed_at=unixepoch() WHERE email=?").bind(email).run();
      return h.reply(request, { ok: true, subscribed: false, email });
    }
  }
  if (path === "/subscribers/count" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const totals = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN unsubscribed_at IS NULL THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN source='program' AND unsubscribed_at IS NULL THEN 1 ELSE 0 END) AS fromProgram FROM subscribers").first<{ total: number; active: number; fromProgram: number }>();
    return h.reply(request, { total: Number(totals?.total || 0), active: Number(totals?.active || 0), fromProgram: Number(totals?.fromProgram || 0) });
  }

  return null;
}
