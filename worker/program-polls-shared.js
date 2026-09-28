/* הסקרים של אתר התוכניות — כללים משותפים לשרת ולדף הניהול (app/admin/programs-polls.tsx).

   ההגדרה של הסקרים נשמרת ב־settings.polls: בטיוטה המשותפת (/api/program/draft) עד הפרסום, ואחריו
   ב־program_settings ("polls"). פרסום שבו אין השדה `polls` אינו נוגע בסקרים — אבל טיוטה שנשמרה בלי
   השדה הייתה נטענת בניהול הישן כ"אין סקרים", והפרסום הבא משם מחק את כולם. לכן אף שמירה אינה
   מאבדת את השדה: מה שחסר נלקח מהטיוטה הקודמת או ממה שמפורסם (`withPolls`).

   `normPollDraft` מנרמל כמו הניהול הישן (rosh-berosh-2/assets/js/store.js, normPoll): בלי לכבות סקר
   ובלי לזרוק תשובות ריקות, כדי שאפשר יהיה לערוך. הנרמול הסופי (worker/program-polls.ts) נעשה בפרסום. */

export const POLL_LIMITS = { polls: 50, options: 40, episodes: 300, question: 300, title: 120, description: 1000, label: 120, sub: 120, thanks: 200, buttonLabel: 40 };
export const POLL_LAYOUTS = ["list", "grid", "cards"];
export const POLL_SHAPES = ["circle", "square", "rounded"];
export const POLL_SIZES = ["s", "m", "l"];
export const POLL_IMAGE_SHAPES = ["wide", "square", "circle"];
export const POLL_RESULTS = ["after", "always", "closed", "admin"];

/** settings.polls כפי שהוא, או undefined כשהשדה חסר (ולא "אין סקרים") */
export function pollsIn(settings) {
  return settings && typeof settings === "object" && Array.isArray(settings.polls) ? settings.polls : undefined;
}

/** ההגדרות עם השדה polls: מה שכבר בהן, ואם חסר — הראשון מבין `fallbacks` שהוא רשימה. בלי אף רשימה — כמו שהן. */
export function withPolls(settings, ...fallbacks) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || Array.isArray(settings.polls)) return settings;
  const found = fallbacks.find((item) => Array.isArray(item));
  return found ? { ...settings, polls: found } : settings;
}

const key = (value) => String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
const https = (value) => { const url = String(value ?? "").trim().slice(0, 600); return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : ""; };
const wall = (value) => { const v = String(value ?? "").trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00` : ""; };
const pick = (list, value, fallback) => (list.includes(value) ? value : fallback);
export const newPollId = (length = 10) => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`).slice(0, length);

/** סקר לעריכה — אותם שדות ואותם גבולות כמו בשרת, בלי לכבות ובלי לזרוק תשובות ריקות */
export function normPollDraft(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const seen = new Set();
  const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, POLL_LIMITS.options).map((o) => {
    let id = key(o?.id) || newPollId(8);
    while (seen.has(id)) id += "x";
    seen.add(id);
    return { id, label: String(o?.label ?? "").slice(0, POLL_LIMITS.label), sub: String(o?.sub ?? "").slice(0, POLL_LIMITS.sub), image: https(o?.image) };
  });
  const show = raw.show && typeof raw.show === "object" ? raw.show : {};
  const multi = raw.multi === true;
  const hue = Math.round(Number(raw.hue));
  const filled = options.filter((o) => o.label.trim()).length;
  return {
    id: key(raw.id) || newPollId(12),
    enabled: raw.enabled === true,
    title: String(raw.title ?? "").slice(0, POLL_LIMITS.title), question: String(raw.question ?? "").slice(0, POLL_LIMITS.question), description: String(raw.description ?? "").slice(0, POLL_LIMITS.description),
    image: https(raw.image), imageShape: pick(POLL_IMAGE_SHAPES, raw.imageShape, "wide"), hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 42,
    layout: pick(POLL_LAYOUTS, raw.layout, "list"), optionShape: pick(POLL_SHAPES, raw.optionShape, "circle"), optionSize: pick(POLL_SIZES, raw.optionSize, "m"),
    multi, maxChoices: multi ? Math.max(1, Math.min(filled || 1, Math.round(Number(raw.maxChoices)) || filled || 1)) : 1,
    allowChange: raw.allowChange !== false, results: pick(POLL_RESULTS, raw.results, "after"),
    from: wall(raw.from), until: wall(raw.until),
    thanks: String(raw.thanks ?? "").slice(0, POLL_LIMITS.thanks), buttonLabel: String(raw.buttonLabel ?? "").slice(0, POLL_LIMITS.buttonLabel),
    show: { home: show.home === true, archive: show.archive === true, me: show.me === true, allEpisodes: show.allEpisodes === true, episodes: [...new Set((Array.isArray(show.episodes) ? show.episodes : []).map(String).filter(Boolean))].slice(0, POLL_LIMITS.episodes) },
    options,
    createdAt: String(raw.createdAt || new Date().toISOString()).slice(0, 25),
  };
}

/** סקר חדש: פעיל, עם שתי תשובות ריקות לכתוב בהן, ובלי מקום (בוחרים איפה להציג) */
export function blankPoll(preset = {}) {
  return normPollDraft({
    id: newPollId(12), enabled: true, title: "", question: "", description: "", image: "", imageShape: "wide", hue: 42,
    layout: "list", optionShape: "circle", optionSize: "m", multi: false, maxChoices: 2, allowChange: true, results: "after",
    from: "", until: "", thanks: "", buttonLabel: "", show: { home: false, archive: false, me: false, allEpisodes: false, episodes: [] },
    options: [{ label: "" }, { label: "" }], createdAt: new Date().toISOString(), ...preset,
  });
}

/** הסקר לשמירה בטיוטה: תשובות בלי טקסט ובלי תמונה יורדות, והשאר מנורמל */
export function pollForSave(poll) {
  return normPollDraft({ ...poll, options: (poll?.options || []).filter((o) => String(o?.label ?? "").trim() || o?.image) });
}

export const filledOptions = (poll) => poll.options.filter((o) => o.label.trim());

/** מה חסר כדי שהסקר יוצג באתר (אותם כללים כמו בשרת ובאתר) */
export function pollProblems(poll) {
  const out = [];
  if (!poll.question.trim() && !poll.title.trim()) out.push("חסרה שאלה");
  if (filledOptions(poll).length < 2) out.push("צריך לפחות שתי תשובות");
  if (poll.until && poll.from && poll.until <= poll.from) out.push("מועד הסגירה לפני הפתיחה");
  return out;
}

/** איפה הסקר מוצג באתר (polls.js: דף הבית, הארכיון, האזור האישי, דפי תוכניות) */
export function pollPlaces(poll, episodeLabel = (id) => id) {
  const s = poll.show, out = [];
  if (s.home) out.push("דף הבית");
  if (s.archive) out.push("הארכיון");
  if (s.me) out.push("האזור האישי");
  if (s.allEpisodes) out.push("כל דפי התוכניות");
  else if (s.episodes.length) out.push(s.episodes.length === 1 ? `דף תוכנית: ${episodeLabel(s.episodes[0])}` : `${s.episodes.length} דפי תוכניות`);
  return out;
}

/** המצב של הסקר עכשיו (שעון ישראל, "YYYY-MM-DDTHH:MM") */
export function pollState(poll, now) {
  if (!poll.enabled) return { cls: "off", text: "כבוי" };
  if (pollProblems(poll).length) return { cls: "warn", text: "לא יוצג — חסרים פרטים" };
  if (!pollPlaces(poll).length) return { cls: "warn", text: "לא נבחר איפה להציג" };
  if (poll.from && poll.from > now) return { cls: "soon", text: `ייפתח ב־${fmtWall(poll.from, now)}` };
  if (poll.until && poll.until <= now) return { cls: "closed", text: "ההצבעה נסגרה" };
  return { cls: "live", text: poll.until ? `פתוח עד ${fmtWall(poll.until, now)}` : "פתוח להצבעה" };
}

/** "2026-10-01T20:00" ← "1.10 20:00" (השנה רק כשאינה השנה הנוכחית) */
export function fmtWall(value, now = "") {
  const [date, time] = String(value).split("T");
  const [y, m, d] = date.split("-").map(Number);
  return `${d}.${m}${String(y) !== String(now).slice(0, 4) ? `.${y}` : ""}${time && time !== "00:00" ? ` ${time}` : ""}`;
}

/** מועד סגירה בעוד `days` ימים בשמונה בערב, מהפתיחה (אם בעתיד) או מעכשיו */
export function untilIn(days, from, now) {
  const base = from && from > now ? from : now;
  const at = new Date(Date.parse(`${base}:00Z`) + days * 86400000);
  return `${at.toISOString().slice(0, 10)}T20:00`;
}
