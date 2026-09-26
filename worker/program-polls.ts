/* סקרים באתר התוכניות (rosh-berosh-2).
   ההגדרה של כל סקר (שאלה, אפשרויות, עיצוב, איפה מוצג ומתי פתוח) נשמרת עם
   הגדרות האתר (program_settings, המפתח "polls") ומתפרסמת יחד עם הקטלוג —
   כמו ההודעה בדף הבית: טיוטה, פרסום וגרסאות. ההצבעות נשמרות בטבלה
   program_poll_votes: שורה לכל אפשרות שמאזין בחר, מאזין מחובר אחד להצבעה אחת.
   מי רואה תוצאות — לפי ההגדרה של הסקר (results); מנהלים רואים תמיד. */
import { readSession, type SessionUser } from "./auth";
import { checkBallotRate } from "./rate-limit";
import { israelWallClock } from "./program-schedule.js";

type Env = { DB: D1Database; ADMIN_EMAILS?: string };
type Reply = (request: Request, body: unknown, status?: number) => Response;

export const POLL_MAX = 50;
export const POLL_OPTIONS_MAX = 40;
export const POLL_EPISODES_MAX = 300;
const LAYOUTS = ["list", "grid", "cards"] as const;
const SHAPES = ["circle", "square", "rounded"] as const;
const SIZES = ["s", "m", "l"] as const;
const IMAGE_SHAPES = ["wide", "square", "circle"] as const;
const RESULTS = ["after", "always", "closed", "admin"] as const;

const text = (value: unknown, max = 300) => String(value ?? "").trim().slice(0, max);
const pick = <T extends readonly string[]>(list: T, value: unknown, fallback: T[number]): T[number] => ((list as readonly string[]).includes(String(value)) ? String(value) : fallback) as T[number];
const pollId = (value: unknown) => String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
const episodeRef = (value: unknown) => String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
/** קישור לתמונה: https בלבד (התמונות מועלות ל־R2 ומוגשות מ־/media/) */
const imageUrl = (value: unknown) => { const url = text(value, 600); return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : ""; };
/** "YYYY-MM-DDTHH:MM" בשעון ישראל, או "" */
const wallClock = (value: unknown) => { const v = String(value ?? "").trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00` : ""; };

export type PollOption = { id: string; label: string; sub: string; image: string };
export type Poll = {
  id: string; enabled: boolean; title: string; question: string; description: string;
  image: string; imageShape: typeof IMAGE_SHAPES[number]; hue: number;
  layout: typeof LAYOUTS[number]; optionShape: typeof SHAPES[number]; optionSize: typeof SIZES[number];
  multi: boolean; maxChoices: number; allowChange: boolean; results: typeof RESULTS[number];
  from: string; until: string; thanks: string; buttonLabel: string;
  show: { home: boolean; archive: boolean; me: boolean; allEpisodes: boolean; episodes: string[] };
  options: PollOption[]; createdAt: string;
};

/** סקר אחד: שדות לא מוכרים נזרקים, ערכים לא תקינים חוזרים לברירת המחדל. */
export function normalizePoll(raw: unknown): Poll | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const id = pollId(p.id) || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const seen = new Set<string>();
  const options = (Array.isArray(p.options) ? p.options : []).slice(0, POLL_OPTIONS_MAX).flatMap((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const label = text(o.label, 120);
    if (!label) return [];
    let oid = pollId(o.id) || crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    while (seen.has(oid)) oid = `${oid}x`;
    seen.add(oid);
    return [{ id: oid, label, sub: text(o.sub, 120), image: imageUrl(o.image) }];
  });
  const show = (p.show && typeof p.show === "object" ? p.show : {}) as Record<string, unknown>;
  const multi = p.multi === true;
  const hue = Math.round(Number(p.hue));
  return {
    id,
    // סקר בלי שאלה או עם פחות משתי אפשרויות לא יכול להיות פעיל
    enabled: p.enabled === true && options.length >= 2 && !!(text(p.question, 300) || text(p.title, 120)),
    title: text(p.title, 120), question: text(p.question, 300), description: text(p.description, 1000),
    image: imageUrl(p.image), imageShape: pick(IMAGE_SHAPES, p.imageShape, "wide"),
    hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 42,
    layout: pick(LAYOUTS, p.layout, "list"), optionShape: pick(SHAPES, p.optionShape, "circle"), optionSize: pick(SIZES, p.optionSize, "m"),
    multi, maxChoices: multi ? Math.max(1, Math.min(options.length || 1, Math.round(Number(p.maxChoices)) || options.length || 1)) : 1,
    allowChange: p.allowChange !== false, results: pick(RESULTS, p.results, "after"),
    from: wallClock(p.from), until: wallClock(p.until),
    thanks: text(p.thanks, 200), buttonLabel: text(p.buttonLabel, 40),
    show: {
      home: show.home === true, archive: show.archive === true, me: show.me === true, allEpisodes: show.allEpisodes === true,
      episodes: [...new Set((Array.isArray(show.episodes) ? show.episodes : []).map(episodeRef).filter(Boolean))].slice(0, POLL_EPISODES_MAX),
    },
    options,
    createdAt: /^\d{4}-\d{2}-\d{2}/.test(String(p.createdAt || "")) ? String(p.createdAt).slice(0, 25) : new Date().toISOString(),
  };
}

export function normalizePolls(raw: unknown): Poll[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : []).slice(0, POLL_MAX).flatMap((item) => {
    const poll = normalizePoll(item);
    if (!poll || seen.has(poll.id)) return [];
    seen.add(poll.id);
    return [poll];
  });
}

/** פתוח להצבעה עכשיו: פעיל, ההתחלה הגיעה והסיום עוד לא (שעון ישראל). */
export function pollOpen(poll: Poll, now = israelWallClock()) {
  return poll.enabled && (!poll.from || poll.from <= now) && (!poll.until || now < poll.until);
}
/** נסגר: היה פעיל והסיום עבר. */
export function pollClosed(poll: Poll, now = israelWallClock()) {
  return poll.enabled && !!poll.until && now >= poll.until;
}

/** לציבור: רק סקרים פעילים שכבר התחילו (גם אם נסגרו — כדי להציג תוצאות). מנהלים מקבלים הכול. */
export function publicPolls(polls: Poll[], includeHidden = false, now = israelWallClock()) {
  return includeHidden ? polls : polls.filter((poll) => poll.enabled && (!poll.from || poll.from <= now));
}

export async function readPolls(env: Env): Promise<Poll[]> {
  const row = await env.DB.prepare("SELECT value_json FROM program_settings WHERE key='polls'").first<{ value_json: string }>();
  if (!row) return [];
  try { return normalizePolls(JSON.parse(row.value_json)); } catch { return []; }
}

/** מותר לראות את התוצאות? */
function resultsVisible(poll: Poll, user: SessionUser | null, voted: boolean, now = israelWallClock()) {
  if (user?.isAdmin) return true;
  if (poll.results === "admin") return false;
  if (poll.results === "always") return true;
  if (poll.results === "closed") return pollClosed(poll, now);
  return voted || pollClosed(poll, now);
}

/** מצב הסקרים לבקשה: לכל סקר — פתוח/סגור, מה המאזין בחר, והתוצאות אם מותר לו לראות. */
async function pollStatus(env: Env, polls: Poll[], user: SessionUser | null) {
  const out: Record<string, { open: boolean; closed: boolean; mine: string[]; total: number | null; counts: Record<string, number> | null }> = {};
  if (!polls.length) return out;
  const ids = polls.map((poll) => poll.id);
  const marks = ids.map(() => "?").join(",");
  const [counts, voters, mine] = await env.DB.batch([
    env.DB.prepare(`SELECT poll_id AS poll, option_id AS option, COUNT(*) AS n FROM program_poll_votes WHERE poll_id IN (${marks}) GROUP BY poll_id, option_id`).bind(...ids),
    env.DB.prepare(`SELECT poll_id AS poll, COUNT(DISTINCT user_sub) AS n FROM program_poll_votes WHERE poll_id IN (${marks}) GROUP BY poll_id`).bind(...ids),
    env.DB.prepare(`SELECT poll_id AS poll, option_id AS option FROM program_poll_votes WHERE user_sub=? AND poll_id IN (${marks})`).bind(user?.sub || "", ...ids),
  ]);
  const now = israelWallClock();
  for (const poll of polls) {
    const chosen = (mine.results as Array<{ poll: string; option: string }>).filter((row) => row.poll === poll.id).map((row) => row.option);
    const show = resultsVisible(poll, user, chosen.length > 0, now);
    const map: Record<string, number> = {};
    for (const option of poll.options) map[option.id] = 0;
    for (const row of counts.results as Array<{ poll: string; option: string; n: number }>) if (row.poll === poll.id && row.option in map) map[row.option] = Number(row.n) || 0;
    const total = Number((voters.results as Array<{ poll: string; n: number }>).find((row) => row.poll === poll.id)?.n || 0);
    out[poll.id] = { open: pollOpen(poll, now), closed: pollClosed(poll, now), mine: user?.sub ? chosen : [], total: show ? total : null, counts: show ? map : null };
  }
  return out;
}

export async function pollsApi(request: Request, env: Env, h: { reply: Reply; admin: (request: Request, env: Env) => Promise<SessionUser | null> }): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/program".length);
  const method = request.method;
  if (path !== "/polls" && !path.startsWith("/polls/")) return null;
  const body = async <T>() => { try { return await request.json<T>(); } catch { return {} as T; } };

  /* GET /polls?ids=a,b — מצב הסקרים (בלי ids: כל הסקרים הציבוריים; מנהל — כולם) */
  if (path === "/polls" && method === "GET") {
    const user = await readSession(request, env);
    const all = publicPolls(await readPolls(env), !!user?.isAdmin);
    const wanted = new Set((url.searchParams.get("ids") || "").split(",").map(pollId).filter(Boolean));
    const polls = wanted.size ? all.filter((poll) => wanted.has(poll.id)) : all;
    return h.reply(request, { polls: await pollStatus(env, polls.slice(0, POLL_MAX), user) });
  }

  /* POST /polls/vote { pollId, choices: [optionId…] } — מאזין מחובר */
  if (path === "/polls/vote" && method === "POST") {
    const user = await readSession(request, env);
    if (!user?.sub) return h.reply(request, { error: "צריך להתחבר כדי להצביע." }, 401);
    if (!(await checkBallotRate(env.DB, `ppoll:${user.sub}`))) return h.reply(request, { error: "יותר מדי בקשות. נסו שוב בעוד דקה." }, 429);
    const input = await body<{ pollId?: unknown; choices?: unknown }>();
    const poll = (await readPolls(env)).find((item) => item.id === pollId(input.pollId));
    if (!poll || !poll.enabled) return h.reply(request, { error: "הסקר לא נמצא." }, 404);
    if (!pollOpen(poll)) return h.reply(request, { error: pollClosed(poll) ? "ההצבעה בסקר הזה נסגרה." : "ההצבעה בסקר הזה עוד לא נפתחה." }, 409);
    const valid = new Set(poll.options.map((option) => option.id));
    const choices = [...new Set((Array.isArray(input.choices) ? input.choices : []).map(pollId))].filter((id) => valid.has(id));
    if (!choices.length) return h.reply(request, { error: "בחרו אפשרות." }, 400);
    if (choices.length > poll.maxChoices) return h.reply(request, { error: poll.maxChoices === 1 ? "אפשר לבחור אפשרות אחת." : `אפשר לבחור עד ${poll.maxChoices} אפשרויות.` }, 400);
    const before = await env.DB.prepare("SELECT 1 AS one FROM program_poll_votes WHERE poll_id=? AND user_sub=? LIMIT 1").bind(poll.id, user.sub).first();
    if (before && !poll.allowChange) return h.reply(request, { error: "כבר הצבעתם בסקר הזה." }, 409);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM program_poll_votes WHERE poll_id=? AND user_sub=?").bind(poll.id, user.sub),
      ...choices.map((option) => env.DB.prepare("INSERT INTO program_poll_votes (poll_id,user_sub,option_id) VALUES (?,?,?)").bind(poll.id, user.sub, option)),
    ]);
    return h.reply(request, { ok: true, poll: (await pollStatus(env, [poll], user))[poll.id] });
  }

  /* POST /polls/reset { pollId } — מנהל: מחיקת כל ההצבעות בסקר */
  if (path === "/polls/reset" && method === "POST") {
    if (!await h.admin(request, env)) return h.reply(request, { error: "אין הרשאת ניהול." }, 403);
    const id = pollId((await body<{ pollId?: unknown }>()).pollId);
    if (!id) return h.reply(request, { error: "חסר מזהה סקר." }, 400);
    await env.DB.prepare("DELETE FROM program_poll_votes WHERE poll_id=?").bind(id).run();
    return h.reply(request, { ok: true });
  }
  return h.reply(request, { error: "לא נמצא." }, 404);
}
