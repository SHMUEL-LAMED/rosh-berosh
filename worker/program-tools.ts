/* כלי הניהול של אתר התוכניות (rosh-berosh-2), מעבר לקטלוג עצמו:
   הגדרות האתר (הודעה בדף הבית, דף עדכונים), טיוטה משותפת בין מכשירים,
   קישור תצוגה מקדימה, גרסאות שנשמרות אוטומטית בכל פרסום, אירועי האזנה
   לסטטיסטיקה, הודעות מהמאזינים, רשימת המנהלים (אותה רשימה של אתר הסקר)
   ורשימת התפוצה (אותה טבלה של אתר הסקר, עם חשבון Google המחובר). */
import { configuredAdminEmails, createSession, readAdminEmails, readSession, saveAdminEmails, sessionCookie, type SessionUser } from "./auth";
import { checkBallotRate } from "./rate-limit";
import { isValidEmail, normalizeEmail, normalizeName } from "./subscribers.js";
import { israelHour } from "./program-schedule.js";

type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type Helpers = {
  reply: (request: Request, body: unknown, status?: number) => Response;
  admin: (request: Request, env: Env) => Promise<SessionUser | null>;
  safeId: (value: unknown) => string;
};

export const PUBLIC_SETTING_KEYS = ["banner", "updates"] as const;
/** כתובת אתר התוכניות (GitHub Pages) — יעד המעבר מניהול הסקר. */
export const PROGRAM_SITE = "https://shmuel-lamed.github.io/rosh-berosh-2/";
const HANDOFF_TTL = 180;
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
  const sites = (b.sites && typeof b.sites === "object" ? b.sites : {}) as Record<string, unknown>;
  return {
    enabled: !!b.enabled && !!message, text: message, link: text(b.link, 500), linkLabel: text(b.linkLabel, 80),
    until: /^\d{4}-\d{2}-\d{2}/.test(String(b.until || "")) ? String(b.until).slice(0, 10) : "",
    // באילו אתרים ההודעה מופיעה: אתר התוכניות (ברירת מחדל) ו/או אתר הסקר
    sites: { program: sites.program !== false, survey: sites.survey === true },
  };
}

/** דף העדכונים: הודעות קצרות עם תאריך. הפריטים נשמרים מהחדש לישן. */
export function normalizeUpdates(raw: unknown) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 200).map((item) => {
    const u = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return { id: text(u.id, 40) || crypto.randomUUID(), date: /^\d{4}-\d{2}-\d{2}/.test(String(u.date || "")) ? String(u.date).slice(0, 10) : day(), title: text(u.title, 160), text: text(u.text, MAX_TEXT), link: text(u.link, 500), pinned: !!u.pinned };
  }).filter((u) => u.title || u.text).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date));
}

/** ההודעה פעילה עכשיו? (מסומנת, יש טקסט, והתאריך לא עבר) */
export function bannerLive(banner: ReturnType<typeof normalizeBanner>) {
  return banner.enabled && !!banner.text && (!banner.until || banner.until >= day());
}

/** הסקר הפעיל, כפי שאתר התוכניות מציג אותו: שם, האם ההצבעה פתוחה, וכתובת. */
export async function activeSurveyStatus(env: Env, origin: string) {
  try {
    const row = await env.DB.prepare("SELECT s.id, s.name, COALESCE(p.voting_open,0) AS open FROM surveys s LEFT JOIN poll_settings p ON p.id=s.id WHERE s.active=1 ORDER BY s.created_at DESC LIMIT 1").first<{ id: string; name: string; open: number }>();
    if (!row) return null;
    return { id: row.id, name: row.name, open: !!Number(row.open), url: `${origin}/` };
  } catch { return null; }
}

/** מה מתפרסם לציבור יחד עם הקטלוג. */
export async function publicSettings(env: Env, origin = "") {
  const rows = await env.DB.prepare("SELECT key,value_json FROM program_settings WHERE key IN ('banner','updates')").all<{ key: string; value_json: string }>();
  const values = new Map(rows.results.map((row) => { try { return [row.key, JSON.parse(row.value_json)]; } catch { return [row.key, null]; } }));
  return { banner: normalizeBanner(values.get("banner")), updates: normalizeUpdates(values.get("updates")), survey: await activeSurveyStatus(env, origin) };
}

/** משפטי הכתיבה של ההגדרות שהגיעו עם פרסום הקטלוג. */
export function settingsStatements(env: Env, raw: unknown) {
  const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const statements = [];
  if ("banner" in settings) statements.push(settingStatement(env, "banner", normalizeBanner(settings.banner)));
  if ("updates" in settings) statements.push(settingStatement(env, "updates", normalizeUpdates(settings.updates)));
  return statements;
}

/** גרסה נשמרת אוטומטית בכל פרסום; רק האחרונות נשארות. `id` — מזהה הגרסה החדשה. */
export function versionStatements(env: Env, by: string, snapshot: { seasons: unknown[]; episodes: unknown[]; settings?: unknown }, id: string = crypto.randomUUID()) {
  return [
    env.DB.prepare("INSERT INTO program_versions (id,by_email,episodes,data_json) VALUES (?,?,?,?)").bind(id, by, snapshot.episodes.length, JSON.stringify(snapshot)),
    env.DB.prepare(`DELETE FROM program_versions WHERE id NOT IN (SELECT id FROM program_versions ORDER BY created_at DESC, rowid DESC LIMIT ${VERSIONS_KEPT})`),
  ];
}

/** הגרסה האחרונה שפורסמה (להגנה מפני פרסום על גבי פרסום של מישהו אחר). */
export async function latestVersion(env: Env) {
  return await env.DB.prepare("SELECT id, by_email AS by, created_at AS createdAt FROM program_versions ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .first<{ id: string; by: string | null; createdAt: number }>() ?? null;
}

export const REFS = ["whatsapp", "google", "facebook", "direct", "internal", "other"] as const;
export const normalizeRef = (value: unknown) => (REFS as readonly string[]).includes(String(value)) ? String(value) : "other";
export const USERDATA_MAX = 300 * 1024;
export const RETENTION_BUCKETS = Array.from({ length: 20 }, (_, i) => i * 5);

/** לכל סף (0,5,…,95): כמה מאזינים שונים הגיעו לאחוז הזה לפחות. */
export function retentionCurve(maxima: Array<{ pct: number }>) {
  return RETENTION_BUCKETS.map((pct) => ({ pct, listeners: maxima.filter((row) => Number(row.pct) >= pct).length }));
}

export async function programToolsApi(request: Request, env: Env, h: Helpers): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/program".length);
  const method = request.method;
  const body = async <T>() => { try { return await request.json<T>(); } catch { return {} as T; } };
  const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
  const tooMany = () => h.reply(request, { error: "יותר מדי בקשות. נסו שוב בעוד דקה." }, 429);
  const forbidden = () => h.reply(request, { error: "אין הרשאת ניהול." }, 403);
  const redirect = (to: string, cookie?: string) => { const headers = new Headers({ location: to, "cache-control": "no-store" }); if (cookie) headers.set("set-cookie", cookie); return new Response(null, { status: 302, headers }); };

  /* ---------- כניסה אחת לשני האתרים: מעבר עם קוד חד־פעמי ----------
     המשתמש מחובר באתר אחד (טוקן באתר התוכניות, עוגייה באתר הסקר) ומבקש
     קוד; האתר השני ממיר את הקוד לסשן משלו לאותו חשבון. הקוד תקף לשלוש
     דקות ולשימוש אחד. */
  const issueHandoff = async (user: SessionUser) => {
    const code = crypto.randomUUID().replace(/-/g, "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM program_settings WHERE key LIKE 'handoff:%' AND updated_at < unixepoch()-?").bind(HANDOFF_TTL),
      settingStatement(env, `handoff:${code}`, { sub: user.sub, email: user.email, name: user.name, picture: user.picture || null }),
    ]);
    return code;
  };
  const redeemHandoff = async (code: string): Promise<SessionUser | null> => {
    if (!/^[a-f0-9]{32}$/.test(code)) return null;
    const row = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key=? AND updated_at >= unixepoch()-?").bind(`handoff:${code}`, HANDOFF_TTL).first<{ value_json: string }>();
    await env.DB.prepare("DELETE FROM program_settings WHERE key=?").bind(`handoff:${code}`).run();
    if (!row) return null;
    try { const u = JSON.parse(row.value_json); const admins = await readAdminEmails(env); return { sub: u.sub, email: u.email, name: u.name, picture: u.picture || undefined, isAdmin: admins.includes(String(u.email).toLowerCase()), exp: 0 }; }
    catch { return null; }
  };
  if (path === "/handoff" && method === "POST") {
    const user = await readSession(request, env);
    if (!user) return h.reply(request, { error: "לא מחוברים." }, 401);
    const code = await issueHandoff(user);
    return h.reply(request, { code, toSurvey: `${url.origin}/api/program/handoff/${code}`, toPrograms: `${PROGRAM_SITE}admin.html?handoff=${code}` });
  }
  if (path === "/handoff/to-programs" && method === "GET") {
    const user = await readSession(request, env);
    if (!user) return redirect("/admin");
    const code = await issueHandoff(user);
    return redirect(`${PROGRAM_SITE}admin.html?handoff=${code}${url.searchParams.get("embed") === "1" ? "&embed=1" : ""}`);
  }
  /* כניסה אחת לשני האתרים. אתר התוכניות שולח את הדפדפן לכאן לרגע (ניווט
     רגיל, שבו עוגיית אתר הסקר נשלחת): מי שמחובר כאן חוזר עם קוד מעבר, ומי
     שלא — חוזר עם sso=none. רק כתובות של אתר התוכניות מותרות כיעד חזרה. */
  const programReturn = (value: string | null) => {
    try { const target = new URL(String(value || "")); const home = new URL(PROGRAM_SITE); return target.origin === home.origin && target.pathname.startsWith(home.pathname) ? target : null; }
    catch { return null; }
  };
  if (path === "/sso" && method === "GET") {
    const back = programReturn(url.searchParams.get("return"));
    if (!back) return h.reply(request, { error: "כתובת חזרה לא תקינה." }, 400);
    back.searchParams.delete("sso"); back.searchParams.delete("handoff");
    const user = await readSession(request, env);
    back.searchParams.set("sso", user ? await issueHandoff(user) : "none");
    return redirect(back.toString());
  }
  if (path.startsWith("/handoff/") && method === "GET") {
    const back = programReturn(url.searchParams.get("return"));
    const user = await redeemHandoff(path.slice("/handoff/".length));
    if (!user) return redirect(back ? back.toString() : "/admin?handoff=expired");
    const token = await createSession(env, user);
    // אחרי כניסה באתר התוכניות: העוגייה של אתר הסקר נקבעת כאן, והדפדפן חוזר לאן שהיה
    return redirect(back ? back.toString() : url.searchParams.get("to") === "/" ? "/" : "/admin", sessionCookie(token));
  }
  if (path === "/auth/handoff" && method === "POST") {
    const { code } = await body<{ code?: string }>();
    const user = await redeemHandoff(String(code || ""));
    if (!user) return h.reply(request, { error: "קוד המעבר פג או כבר נוצל. נסו שוב מהאתר השני." }, 401);
    const token = await createSession(env, user);
    return h.reply(request, { token, user: { email: user.email, name: user.name, picture: user.picture, isAdmin: user.isAdmin } });
  }
  /* התנתקות במקום אחד מנתקת מכל המקומות: כל הסשנים של החשבון נמחקים. */
  if (path === "/logout" && method === "POST") {
    const user = await readSession(request, env);
    if (user?.sub) await env.DB.prepare("DELETE FROM auth_sessions WHERE user_sub=?").bind(user.sub).run();
    return h.reply(request, { ok: true });
  }

  /* ---------- ההודעה המשותפת, כפי שאתר הסקר מציג אותה ---------- */
  if (path === "/banner" && method === "GET") {
    const banner = normalizeBanner(await readSetting(env, "banner"));
    return h.reply(request, { banner: bannerLive(banner) && banner.sites.survey ? banner : null });
  }
  /* ---------- הסקרים, לקישור תוכנית לסקר ---------- */
  if (path === "/surveys" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    try {
      const rows = await env.DB.prepare("SELECT s.id, s.name, s.active, COALESCE(p.voting_open,0) AS open, s.created_at AS createdAt FROM surveys s LEFT JOIN poll_settings p ON p.id=s.id ORDER BY s.active DESC, s.created_at DESC").all();
      return h.reply(request, { surveys: rows.results.map((r) => ({ ...(r as object), active: !!Number((r as { active: number }).active), open: !!Number((r as { open: number }).open) })) });
    } catch { return h.reply(request, { surveys: [] }); }
  }

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
    const event = await body<{ kind?: string; episodeId?: string; seconds?: number; device?: string; pct?: number; ref?: string }>();
    const kind = event.kind === "listen" ? "listen" : "play";
    const episodeId = h.safeId(event.episodeId);
    if (!episodeId) return h.reply(request, { error: "חסר מזהה תוכנית." }, 400);
    const seconds = Math.min(600, Math.max(0, Math.floor(Number(event.seconds) || 0)));
    const device = event.device === "phone" ? "phone" : "desktop";
    const client = await hash(`${clientIp}|${request.headers.get("user-agent") || ""}|${day()}`);
    // מיקום בתוכנית באחוזים (נשלח עם "listen" כל כמה דקות ובעצירה), מקור ההגעה, ושעת ההאזנה בישראל
    const rawPct = Number(event.pct);
    const pct = event.pct === undefined || event.pct === null || !Number.isFinite(rawPct) ? null : Math.min(100, Math.max(0, Math.round(rawPct)));
    const ref = event.ref === undefined || event.ref === null || event.ref === "" ? null : normalizeRef(event.ref);
    await env.DB.prepare("INSERT INTO program_events (episode_id,kind,seconds,device,day,client_hash,pct,ref,hour) VALUES (?,?,?,?,?,?,?,?,?)").bind(episodeId, kind, seconds, device, day(), client, pct, ref, israelHour()).run();
    return h.reply(request, { ok: true });
  }

  /* ---------- סטטיסטיקות (מנהל) ---------- */
  if (path === "/stats" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const since30 = nowSeconds() - 30 * DAY_SECONDS, since7 = nowSeconds() - 7 * DAY_SECONDS;
    const [days, episodes, recent, totals, devices, week, sources, hours, likes] = await env.DB.batch([
      env.DB.prepare("SELECT day, SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners, SUM(seconds) AS seconds FROM program_events WHERE created_at>=? GROUP BY day ORDER BY day").bind(since30),
      env.DB.prepare("SELECT episode_id AS id, SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners, SUM(seconds) AS seconds FROM program_events GROUP BY episode_id ORDER BY plays DESC LIMIT 300"),
      env.DB.prepare("SELECT episode_id AS id, SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners, SUM(seconds) AS seconds FROM program_events WHERE created_at>=? GROUP BY episode_id ORDER BY plays DESC LIMIT 300").bind(since30),
      env.DB.prepare("SELECT SUM(kind='play') AS plays, COUNT(DISTINCT client_hash || day) AS listeners, SUM(seconds) AS seconds FROM program_events"),
      env.DB.prepare("SELECT device, SUM(kind='play') AS plays FROM program_events WHERE created_at>=? GROUP BY device").bind(since30),
      env.DB.prepare("SELECT SUM(kind='play') AS plays, COUNT(DISTINCT client_hash || day) AS listeners FROM program_events WHERE created_at>=?").bind(since7),
      // אירועים מלפני הוספת העמודות (בלי ref/hour) אינם נספרים כאן
      env.DB.prepare("SELECT ref, COUNT(*) AS plays FROM program_events WHERE kind='play' AND created_at>=? AND ref IS NOT NULL GROUP BY ref ORDER BY plays DESC").bind(since30),
      env.DB.prepare("SELECT hour, COUNT(*) AS plays FROM program_events WHERE kind='play' AND created_at>=? AND hour IS NOT NULL GROUP BY hour").bind(since30),
      env.DB.prepare("SELECT episode_id AS id, COUNT(*) AS likes FROM program_likes GROUP BY episode_id ORDER BY likes DESC LIMIT 20"),
    ]);
    const byHour = new Map((hours.results as Array<{ hour: number; plays: number }>).map((row) => [Number(row.hour), Number(row.plays) || 0]));
    const deviceMap: Record<string, number> = {};
    for (const row of devices.results as Array<{ device: string; plays: number }>) deviceMap[row.device] = Number(row.plays) || 0;
    return h.reply(request, { days: days.results, episodes: episodes.results, recent: recent.results, totals: totals.results[0] || {}, week: week.results[0] || {}, devices: deviceMap,
      sources: (sources.results as Array<{ ref: string; plays: number }>).map((row) => ({ ref: row.ref, plays: Number(row.plays) || 0 })),
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, plays: byHour.get(hour) || 0 })),
      likes: (likes.results as Array<{ id: string; likes: number }>).map((row) => ({ id: row.id, likes: Number(row.likes) || 0 })) });
  }
  if (path.startsWith("/stats/episode/") && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const id = h.safeId(decodeURIComponent(path.slice("/stats/episode/".length)));
    if (!id) return h.reply(request, { error: "חסר מזהה תוכנית." }, 400);
    const [totals, maxima] = await env.DB.batch([
      env.DB.prepare("SELECT SUM(kind='play') AS plays, COUNT(DISTINCT client_hash) AS listeners FROM program_events WHERE episode_id=?").bind(id),
      env.DB.prepare("SELECT client_hash, MAX(pct) AS pct FROM program_events WHERE episode_id=? AND pct IS NOT NULL GROUP BY client_hash").bind(id),
    ]);
    const row = (totals.results[0] || {}) as { plays?: number; listeners?: number };
    return h.reply(request, { id, plays: Number(row.plays) || 0, listeners: Number(row.listeners) || 0, retention: retentionCurve(maxima.results as Array<{ pct: number }>) });
  }

  /* ---------- נתונים אישיים לכל חשבון (סנכרון בין מכשירים) ----------
     השרת אינו מפרש את התוכן — הלקוח ממזג — רק בודק שזה אובייקט ושהוא לא גדול מדי. */
  if (path === "/userdata") {
    const user = await readSession(request, env);
    if (!user?.sub) return h.reply(request, { error: "צריך להתחבר." }, 401);
    if (method === "GET") {
      const row = await env.DB.prepare("SELECT data_json, updated_at FROM program_user_data WHERE user_sub=?").bind(user.sub).first<{ data_json: string; updated_at: number }>();
      if (!row) return h.reply(request, { data: null, updatedAt: null });
      let data = null;
      try { data = JSON.parse(row.data_json); } catch { data = null; }
      return h.reply(request, { data, updatedAt: new Date(Number(row.updated_at) * 1000).toISOString() });
    }
    if (method === "PUT") {
      let input: { data?: unknown };
      try { input = await request.json(); } catch { return h.reply(request, { error: "בקשה לא תקינה." }, 400); }
      const data = input?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return h.reply(request, { error: "הנתונים האישיים אינם תקינים." }, 400);
      const serialized = JSON.stringify(data);
      if (new TextEncoder().encode(serialized).length > USERDATA_MAX) return h.reply(request, { error: "הנתונים האישיים גדולים מדי." }, 413);
      const at = nowSeconds();
      await env.DB.prepare("INSERT INTO program_user_data (user_sub,email,data_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_sub) DO UPDATE SET email=excluded.email,data_json=excluded.data_json,updated_at=excluded.updated_at")
        .bind(user.sub, user.email || null, serialized, at).run();
      return h.reply(request, { ok: true, updatedAt: new Date(at * 1000).toISOString() });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM program_user_data WHERE user_sub=?").bind(user.sub).run();
      return h.reply(request, { ok: true });
    }
  }

  /* ---------- לייקים ---------- */
  if (path === "/likes" && method === "GET") {
    const user = await readSession(request, env);
    const [counts, mine] = await env.DB.batch([
      env.DB.prepare("SELECT episode_id AS id, COUNT(*) AS likes FROM program_likes GROUP BY episode_id"),
      env.DB.prepare("SELECT episode_id AS id FROM program_likes WHERE user_sub=?").bind(user?.sub || ""),
    ]);
    const map: Record<string, number> = {};
    for (const row of counts.results as Array<{ id: string; likes: number }>) map[row.id] = Number(row.likes) || 0;
    return h.reply(request, { counts: map, mine: user?.sub ? (mine.results as Array<{ id: string }>).map((row) => row.id) : [] });
  }
  if (path === "/likes" && method === "POST") {
    const user = await readSession(request, env);
    if (!user?.sub) return h.reply(request, { error: "צריך להתחבר כדי לסמן \"אהבתי\"." }, 401);
    if (!(await checkBallotRate(env.DB, `plike:${user.sub}`))) return tooMany();
    const input = await body<{ episodeId?: string; like?: boolean }>();
    const episodeId = h.safeId(input.episodeId);
    if (!episodeId) return h.reply(request, { error: "חסר מזהה תוכנית." }, 400);
    const liked = input.like !== false;
    if (liked) {
      const exists = await env.DB.prepare("SELECT 1 AS one FROM program_episodes WHERE id=?").bind(episodeId).first();
      if (!exists) return h.reply(request, { error: "התוכנית לא נמצאה." }, 404);
      await env.DB.prepare("INSERT OR IGNORE INTO program_likes (user_sub,episode_id) VALUES (?,?)").bind(user.sub, episodeId).run();
    } else {
      await env.DB.prepare("DELETE FROM program_likes WHERE user_sub=? AND episode_id=?").bind(user.sub, episodeId).run();
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_likes WHERE episode_id=?").bind(episodeId).first<{ total: number }>();
    return h.reply(request, { ok: true, liked, count: Number(count?.total || 0) });
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
    const fixed = configuredAdminEmails(env);
    const list = async () => {
      const seen = new Map<string, number>();
      try { for (const row of (await env.DB.prepare("SELECT LOWER(email) AS email, MAX(created_at) AS at FROM auth_sessions GROUP BY LOWER(email)").all<{ email: string; at: number }>()).results) seen.set(row.email, Number(row.at)); } catch { /* אין עדיין סשנים */ }
      return (await readAdminEmails(env)).map((email) => ({ email, fixed: fixed.includes(email), you: email === user.email, lastSeen: seen.get(email) || null }));
    };
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
