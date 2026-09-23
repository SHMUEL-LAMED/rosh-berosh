/* התראות דחיפה של אתר התוכניות: מפתחות VAPID (נוצרים בשימוש הראשון ונשמרים
   ב־program_settings), מנויים (program_push), שליחה ידנית מאזור הניהול,
   התראה על תוכניות חדשות בפרסום, ובדיקה מתוזמנת (cron) שמודיעה על תוכניות
   מתוזמנות כשמועד הפרסום שלהן מגיע. */
import { readSession, type SessionUser } from "./auth";
import { checkBallotRate } from "./rate-limit";
import { isPublic, israelWallClock, normalizePublishAt } from "./program-schedule.js";
import { PROGRAM_SITE, readSetting, settingStatement } from "./program-tools";
import { b64urlDecode, generateVapidKeys, publicKeyFromJwk, sendWebPush, type VapidKeys } from "./web-push";

type Env = { DB: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type Helpers = {
  reply: (request: Request, body: unknown, status?: number) => Response;
  admin: (request: Request, env: Env) => Promise<SessionUser | null>;
};
type Episode = Record<string, unknown> & { id: string };

export const VAPID_SUBJECT = "mailto:rbr17011701@gmail.com";
export const PUSH_ICON = "https://shmuel-lamed.github.io/rosh-berosh-2/assets/img/icon-192.png";
export const NOTIFIED_KEY = "push-notified";
const MAX_PER_RUN = 3;
const CONCURRENCY = 10;
const NOTIFIED_KEPT = 5000;

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

/** מפתחות VAPID. שני מופעים שיוצרים בו־זמנית — רק הראשון נשמר, וכולם קוראים אותו. */
export async function vapidKeys(env: Env): Promise<VapidKeys> {
  const saved = await readSetting<VapidKeys>(env, "vapid");
  if (saved?.publicKey && saved?.privateKey) return saved;
  const fresh = await generateVapidKeys();
  await env.DB.prepare("INSERT OR IGNORE INTO program_settings (key,value_json,updated_at) VALUES ('vapid',?,unixepoch())").bind(JSON.stringify(fresh)).run();
  return (await readSetting<VapidKeys>(env, "vapid")) || fresh;
}

export type PushMessage = { title: string; body: string; url: string };
type Payload = PushMessage & { icon: string };
/** עבודה בתור: הודעה אחת לכל המנויים, עם סמן — ה־endpoint האחרון שכבר טופל. */
export type PushJob = { id: string; payload: Payload; cursor: string; createdAt: string };
type Send = { endpoint: string; p256dh: string; auth: string; payload: Payload };
export const PENDING_KEY = "push-pending";
/**
 * בתוכנית החינמית של Workers מותרות 50 בקשות יוצאות לכל הפעלה. מנה אחת היא
 * עד 25 שליחות, ועוד כשמונה קריאות ל־D1 ומחיקת מנויים שפג תוקפם — מרווח
 * בטוח מתחת לגבול.
 */
export const BATCH_SIZE = 25;
const MAX_JOBS = 20;
/** כמה פעמים מנסים לתפוס מנה, או להוסיף לתור, כשהפעלה אחרת שינתה אותו באמצע. */
const CLAIM_ATTEMPTS = 3;
const ENQUEUE_ATTEMPTS = 5;

/** התור כפי שהוא שמור — המחרוזת עצמה (לכתיבה המותנית) והעבודות שבה. */
async function readQueue(env: Env): Promise<{ raw: string | null; queue: PushJob[] }> {
  const row = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key=?").bind(PENDING_KEY).first<{ value_json: string }>();
  let saved: unknown = null;
  try { saved = row ? JSON.parse(row.value_json) : null; } catch { saved = null; }
  const queue = Array.isArray(saved) ? (saved as PushJob[]).filter((job) => job && job.payload && typeof job.cursor === "string") : [];
  return { raw: row ? row.value_json : null, queue };
}

/**
 * כתיבה מותנית של התור: נכתבת רק אם הערך השמור הוא עדיין `raw` — מה שנקרא
 * לפני רגע. אם הפעלה אחרת (לולאת הריקון של דף הניהול, ה־cron, שליחה חדשה)
 * שינתה את התור בינתיים, לא נכתב כלום ומוחזר false, והקורא קורא שוב.
 */
async function swapQueue(env: Env, raw: string | null, next: PushJob[]): Promise<boolean> {
  const value = JSON.stringify(next);
  const row = raw === null
    ? await env.DB.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(key) DO NOTHING RETURNING key").bind(PENDING_KEY, value).first()
    : await env.DB.prepare("UPDATE program_settings SET value_json=?,updated_at=unixepoch() WHERE key=? AND value_json=? RETURNING key").bind(value, PENDING_KEY, raw).first();
  return !!row;
}

/**
 * מוסיף עבודות לתור (הודעה אחת לכל עבודה). התור שומר את 20 האחרונות. גם
 * כאן הכתיבה מותנית: אם ריקון מקביל קידם סמן בינתיים, קוראים שוב ומוסיפים
 * על התור המעודכן — כך העבודות החדשות אינן נמחקות בכתיבה שלו, והסמן שלו
 * אינו נדרס בכתיבה שלנו.
 */
export async function enqueuePush(env: Env, messages: PushMessage[]) {
  if (!messages.length) return;
  const jobs = messages.map((message) => ({ id: crypto.randomUUID(), payload: { title: message.title, body: message.body, url: message.url, icon: PUSH_ICON }, cursor: "", createdAt: new Date().toISOString() }));
  for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt += 1) {
    const { raw, queue } = await readQueue(env);
    if (await swapQueue(env, raw, [...queue, ...jobs].slice(-MAX_JOBS))) return;
  }
  throw new Error("push queue is busy");
}

async function remainingFor(env: Env, queue: PushJob[]) {
  let remaining = 0;
  for (const job of queue) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_push WHERE endpoint > ?").bind(job.cursor).first<{ total: number }>();
    remaining += Number(row?.total || 0);
  }
  return remaining;
}

/** המנה הבאה: עד `limit` שליחות על פני העבודות לפי הסדר, והתור שיישאר אחריהן. */
async function planBatch(env: Env, queue: PushJob[], limit: number) {
  const sends: Send[] = [];
  const next: PushJob[] = [];
  let left = limit;
  for (const job of queue) {
    if (left <= 0) { next.push(job); continue; }
    const rows = (await env.DB.prepare("SELECT endpoint,p256dh,auth FROM program_push WHERE endpoint > ? ORDER BY endpoint LIMIT ?").bind(job.cursor, left).all<{ endpoint: string; p256dh: string; auth: string }>()).results;
    for (const row of rows) sends.push({ ...row, payload: job.payload });
    left -= rows.length;
    // פחות שורות ממה שביקשנו — העבודה הגיעה לסוף רשימת המנויים
    if (rows.length && left <= 0) {
      const more = await env.DB.prepare("SELECT 1 AS one FROM program_push WHERE endpoint > ? LIMIT 1").bind(rows[rows.length - 1].endpoint).first();
      if (more) next.push({ ...job, cursor: rows[rows.length - 1].endpoint });
    }
  }
  return { sends, next };
}

/**
 * מעבד מנה אחת מהתור: עד `budget` שליחות (ברירת מחדל 25) על פני העבודות
 * לפי הסדר. המנויים עוברים לפי endpoint בסדר קבוע, עם סמן ולא מספר מקום,
 * כך שמחיקת מנוי שפג תוקפו באמצע אינה מדלגת על אחרים. המנה "נתפסת" לפני
 * השליחה בכתיבה מותנית של הסמנים: רק מי שהתור לא השתנה אצלו מאז שקרא אותו
 * מצליח, כך ששתי הפעלות במקביל (לולאת הריקון של דף הניהול וה־cron) לעולם
 * אינן שולחות את אותה מנה פעמיים. מי שלא הצליח קורא שוב ולוקח את המנה הבאה.
 */
export async function drainPush(env: Env, budget = BATCH_SIZE) {
  const limit = Math.max(0, Math.min(BATCH_SIZE, budget));
  let sends: Send[] = [];
  let next: PushJob[] = [];
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const { raw, queue } = await readQueue(env);
    next = queue;
    if (!queue.length || !limit) break;
    const plan = await planBatch(env, queue, limit);
    if (await swapQueue(env, raw, plan.next)) { sends = plan.sends; next = plan.next; break; }
  }
  let sent = 0, failed = 0;
  const gone = new Set<string>();
  if (sends.length) {
    const keys = await vapidKeys(env);
    let index = 0;
    const worker = async () => {
      while (index < sends.length) {
        const item = sends[index++];
        let status = 0;
        try { status = await sendWebPush(item, item.payload, keys, VAPID_SUBJECT, { ttl: 86400, urgency: "normal" }); }
        catch (error) { console.error("web push error", error); }
        if (status >= 200 && status < 300) sent += 1;
        else if (status === 404 || status === 410) gone.add(item.endpoint);
        else failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sends.length) }, worker));
  }
  const removedList = [...gone];
  for (let i = 0; i < removedList.length; i += 50) {
    const chunk = removedList.slice(i, i + 50);
    await env.DB.prepare(`DELETE FROM program_push WHERE endpoint IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
  }
  return { sent, failed, removed: removedList.length, remaining: await remainingFor(env, next), attempted: sends.length };
}

export function episodeMessage(episode: Episode): PushMessage {
  const title = text(episode.title, 120) || "תוכנית חדשה";
  const number = Number(episode.number);
  const slug = text(episode.slug || episode.id, 120);
  return {
    title: "תוכנית חדשה בראש בראש",
    body: Number.isFinite(number) && number > 0 ? `תוכנית ${number} · ${title}` : title,
    url: `${PROGRAM_SITE}episode.html?ep=${encodeURIComponent(slug)}`,
  };
}

/** עד שלוש תוכניות — התראה לכל אחת; יותר מזה — התראה מסכמת אחת. */
export function episodeMessages(episodes: Episode[]): PushMessage[] {
  if (episodes.length > MAX_PER_RUN) return [{ title: "ראש בראש", body: `${episodes.length} תוכניות חדשות באתר`, url: PROGRAM_SITE }];
  return episodes.map(episodeMessage);
}

/**
 * פרסום עם notify: העבודות רק נכנסות לתור. השליחה עצמה — בלולאת הריקון של
 * דף הניהול (/push/drain) וב־cron, ולא בתוך בקשת הפרסום, כדי שלא ירוצו שני
 * ריקונים במקביל על אותה מנה.
 */
export async function notifyEpisodes(env: Env, episodes: Episode[]) {
  if (!episodes.length) return;
  await enqueuePush(env, episodeMessages(episodes));
}

export function notifiedStatement(env: Env, ids: Iterable<string>) {
  return settingStatement(env, NOTIFIED_KEY, [...new Set(ids)].slice(-NOTIFIED_KEPT));
}

async function publicEpisodes(env: Env): Promise<Episode[]> {
  const now = israelWallClock();
  const rows = (await env.DB.prepare("SELECT id,data_json FROM program_episodes WHERE visible=1").all<{ id: string; data_json: string }>()).results;
  return rows.flatMap((row) => {
    try { const data = { ...JSON.parse(row.data_json), id: row.id }; return isPublic(data, true, now) ? [data] : []; } catch { return []; }
  });
}

/**
 * הבדיקה המתוזמנת (כל חמש דקות): קודם מנה אחת מהתור, ואז תוכניות שמועד
 * הפרסום שלהן עבר, גלויות, ועוד לא נשלחה עליהן התראה — נכנסות לתור (עד
 * שלוש בכל ריצה), ומה שנשאר מהמנה נשלח מיד. בריצה הראשונה כל התוכניות
 * הציבוריות נרשמות כ"כבר הודיעו" בלי לשלוח, כדי שתוכניות ישנות לעולם לא
 * יפעילו התראה.
 */
export async function runScheduledPush(env: Env) {
  const first = await drainPush(env);
  const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_episodes").first<{ total: number }>();
  if (!Number(total?.total)) return { seeded: 0, queued: 0, sent: first.sent };
  const episodes = await publicEpisodes(env);
  const notified = await readSetting<string[]>(env, NOTIFIED_KEY);
  if (!Array.isArray(notified)) {
    await notifiedStatement(env, episodes.map((episode) => episode.id)).run();
    return { seeded: episodes.length, queued: 0, sent: first.sent };
  }
  const known = new Set(notified);
  const due = episodes
    .filter((episode) => normalizePublishAt(episode.publishAt) && !known.has(episode.id))
    .sort((a, b) => normalizePublishAt(a.publishAt).localeCompare(normalizePublishAt(b.publishAt)))
    .slice(0, MAX_PER_RUN);
  if (!due.length) return { seeded: 0, queued: 0, sent: first.sent };
  // נרשמות לפני השליחה, כדי שריצה שנקטעה באמצע לא תכניס שוב את אותה התראה
  await notifiedStatement(env, [...notified, ...due.map((episode) => episode.id)]).run();
  await enqueuePush(env, due.map(episodeMessage));
  const budget = BATCH_SIZE - first.attempted;
  const second = budget > 0 ? await drainPush(env, budget) : { sent: 0 };
  return { seeded: 0, queued: due.length, sent: first.sent + second.sent };
}

/**
 * שירותי הדחיפה של הדפדפנים: Chrome/Edge/Android, Safari, Windows, Firefox
 * ו־Samsung. כתובת שמתחילה בנקודה היא סיומת (כל תת־דומיין שלה). כל כתובת
 * מנוי אחרת נדחית, כדי שהוורקר לא ישמש לשליחת בקשות לכתובות שרירותיות.
 */
export const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", ".push.apple.com", ".notify.windows.com", ".push.samsungosp.com"];
export const pushHostAllowed = (host: string) => PUSH_HOSTS.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
/** עד כמה מכשירים רשומים להתראות לכל חשבון; מנוי חדש מעבר לזה מחליף את הישן ביותר. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

function validSubscription(raw: unknown) {
  const sub = (raw && typeof raw === "object" ? raw : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = String(sub.endpoint || "");
  const p256dh = String(sub.keys?.p256dh || ""), auth = String(sub.keys?.auth || "");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || endpoint.length > 1000) return null;
    if (url.port || url.username || url.password || !pushHostAllowed(url.hostname.toLowerCase())) return null;
    const point = b64urlDecode(p256dh), secret = b64urlDecode(auth);
    if (point.length !== 65 || point[0] !== 4 || secret.length !== 16) return null;
  } catch { return null; }
  return { endpoint, p256dh, auth };
}

export async function programPushApi(request: Request, env: Env, h: Helpers): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/program".length);
  if (!path.startsWith("/push/")) return null;
  const method = request.method;
  const body = async <T>() => { try { return await request.json<T>(); } catch { return {} as T; } };
  const forbidden = () => h.reply(request, { error: "אין הרשאת ניהול." }, 403);

  if (path === "/push/key" && method === "GET") {
    return h.reply(request, { publicKey: publicKeyFromJwk((await vapidKeys(env)).publicKey) });
  }
  if (path === "/push/subscribe" && method === "POST") {
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
    if (!(await checkBallotRate(env.DB, `ppush:${clientIp}`))) return h.reply(request, { error: "יותר מדי בקשות. נסו שוב בעוד דקה." }, 429);
    const { subscription } = await body<{ subscription?: unknown }>();
    const sub = validSubscription(subscription);
    if (!sub) return h.reply(request, { error: "פרטי המנוי להתראות אינם תקינים." }, 400);
    const user = await readSession(request, env);
    await env.DB.prepare("INSERT INTO program_push (endpoint,p256dh,auth,user_sub) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,user_sub=COALESCE(excluded.user_sub,program_push.user_sub)")
      .bind(sub.endpoint, sub.p256dh, sub.auth, user?.sub ?? null).run();
    // תקרה לכל חשבון: נשארים המנוי הזה ועוד 9 החדשים ביותר; הישנים יותר נמחקים
    if (user?.sub) {
      await env.DB.prepare("DELETE FROM program_push WHERE user_sub=? AND endpoint<>? AND endpoint NOT IN (SELECT endpoint FROM program_push WHERE user_sub=? AND endpoint<>? ORDER BY created_at DESC, rowid DESC LIMIT ?)")
        .bind(user.sub, sub.endpoint, user.sub, sub.endpoint, MAX_SUBSCRIPTIONS_PER_USER - 1).run();
    }
    return h.reply(request, { ok: true });
  }
  if (path === "/push/unsubscribe" && method === "POST") {
    const { endpoint } = await body<{ endpoint?: string }>();
    if (!endpoint) return h.reply(request, { error: "חסרה כתובת המנוי." }, 400);
    await env.DB.prepare("DELETE FROM program_push WHERE endpoint=?").bind(String(endpoint)).run();
    return h.reply(request, { ok: true });
  }
  if (path === "/push/send" && method === "POST") {
    if (!await h.admin(request, env)) return forbidden();
    const message = await body<{ title?: string; body?: string; url?: string }>();
    const title = text(message.title, 120), content = text(message.body, 400);
    if (!title && !content) return h.reply(request, { error: "ההתראה ריקה." }, 400);
    let target = PROGRAM_SITE;
    try { if (message.url) { const parsed = new URL(String(message.url), PROGRAM_SITE); if (parsed.protocol === "https:") target = parsed.toString(); } } catch { /* נשאר דף הבית */ }
    // נכנס לתור ומנה ראשונה (עד 25) נשלחת מיד; את השאר שולחים ב־/push/drain
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_push").first<{ total: number }>();
    try { await enqueuePush(env, [{ title: title || "ראש בראש", body: content, url: target }]); }
    catch (error) { console.error("program push enqueue error", error); return h.reply(request, { error: "תור ההתראות עמוס כרגע. נסו שוב בעוד רגע." }, 503); }
    const { sent, failed, removed, remaining } = await drainPush(env);
    return h.reply(request, { queued: true, sent, failed, removed, remaining, total: Number(count?.total || 0) });
  }
  if (path === "/push/drain" && method === "POST") {
    if (!await h.admin(request, env)) return forbidden();
    const { sent, failed, removed, remaining } = await drainPush(env);
    return h.reply(request, { sent, failed, removed, remaining });
  }
  if (path === "/push/count" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_push").first<{ total: number }>();
    return h.reply(request, { total: Number(row?.total || 0) });
  }
  return null;
}
