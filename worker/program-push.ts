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

/** שולח לכל המנויים (עשרה במקביל); מנוי ששרת הדחיפה עונה עליו 404/410 נמחק. */
export async function sendToAll(env: Env, message: PushMessage) {
  const keys = await vapidKeys(env);
  const rows = (await env.DB.prepare("SELECT endpoint,p256dh,auth FROM program_push").all<{ endpoint: string; p256dh: string; auth: string }>()).results;
  const payload = { title: message.title, body: message.body, url: message.url, icon: PUSH_ICON };
  let sent = 0, failed = 0;
  const gone: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      let status = 0;
      try { status = await sendWebPush(row, payload, keys, VAPID_SUBJECT, { ttl: 86400, urgency: "normal" }); }
      catch (error) { console.error("web push error", error); }
      if (status >= 200 && status < 300) sent += 1;
      else if (status === 404 || status === 410) gone.push(row.endpoint);
      else failed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  for (let i = 0; i < gone.length; i += 50) {
    const chunk = gone.slice(i, i + 50);
    await env.DB.prepare(`DELETE FROM program_push WHERE endpoint IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
  }
  return { sent, failed, removed: gone.length, total: rows.length };
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
export async function notifyEpisodes(env: Env, episodes: Episode[]) {
  if (!episodes.length) return;
  if (episodes.length > MAX_PER_RUN) {
    await sendToAll(env, { title: "ראש בראש", body: `${episodes.length} תוכניות חדשות באתר`, url: PROGRAM_SITE });
    return;
  }
  for (const episode of episodes) await sendToAll(env, episodeMessage(episode));
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
 * הבדיקה המתוזמנת (כל רבע שעה): תוכנית שמועד הפרסום שלה עבר, גלויה, ועוד
 * לא נשלחה עליה התראה — מקבלת התראה (עד שלוש בכל ריצה). בריצה הראשונה כל
 * התוכניות הציבוריות נרשמות כ"כבר הודיעו" בלי לשלוח, כדי שתוכניות ישנות
 * לעולם לא יפעילו התראה.
 */
export async function runScheduledPush(env: Env) {
  const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_episodes").first<{ total: number }>();
  if (!Number(total?.total)) return { seeded: 0, sent: 0 };
  const episodes = await publicEpisodes(env);
  const notified = await readSetting<string[]>(env, NOTIFIED_KEY);
  if (!Array.isArray(notified)) {
    await notifiedStatement(env, episodes.map((episode) => episode.id)).run();
    return { seeded: episodes.length, sent: 0 };
  }
  const known = new Set(notified);
  const due = episodes
    .filter((episode) => normalizePublishAt(episode.publishAt) && !known.has(episode.id))
    .sort((a, b) => normalizePublishAt(a.publishAt).localeCompare(normalizePublishAt(b.publishAt)))
    .slice(0, MAX_PER_RUN);
  if (!due.length) return { seeded: 0, sent: 0 };
  // נרשמות לפני השליחה, כדי שריצה שנקטעה באמצע לא תשלח שוב את אותה התראה
  await notifiedStatement(env, [...notified, ...due.map((episode) => episode.id)]).run();
  for (const episode of due) await sendToAll(env, episodeMessage(episode));
  return { seeded: 0, sent: due.length };
}

function validSubscription(raw: unknown) {
  const sub = (raw && typeof raw === "object" ? raw : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = String(sub.endpoint || "");
  const p256dh = String(sub.keys?.p256dh || ""), auth = String(sub.keys?.auth || "");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || endpoint.length > 1000) return null;
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
    return h.reply(request, await sendToAll(env, { title: title || "ראש בראש", body: content, url: target }));
  }
  if (path === "/push/count" && method === "GET") {
    if (!await h.admin(request, env)) return forbidden();
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM program_push").first<{ total: number }>();
    return h.reply(request, { total: Number(row?.total || 0) });
  }
  return null;
}
