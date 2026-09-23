/* זמנים באתר התוכניות. `publishAt` של תוכנית נכתב בשעון ישראל המקומי
   ("2026-10-01T20:00"), ולכן ההשוואה נעשית מול השעה הנוכחית בישראל — מחושבת
   דרך Intl עם אזור הזמן Asia/Jerusalem, כך ששעון קיץ וחורף מטופלים לבד —
   כהשוואת מחרוזות באותו פורמט בדיוק. */

const ISRAEL = "Asia/Jerusalem";

function israelParts(at) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISRAEL, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  // יש מנועים שמחזירים "24" לחצות גם עם h23
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

/** השעה הנוכחית בישראל כ־"YYYY-MM-DDTHH:MM". */
export function israelWallClock(at = Date.now()) {
  const p = israelParts(at);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** השעה העגולה בישראל, 0–23. */
export function israelHour(at = Date.now()) {
  return Number(israelParts(at).hour) % 24;
}

/** מנרמל ערך publishAt ל־"YYYY-MM-DDTHH:MM", או "" כשאין מועד תקין. */
export function normalizePublishAt(value) {
  const match = String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return "";
  return `${match[1]}T${match[2] ?? "00"}:${match[3] ?? "00"}`;
}

/** תוכנית מתוזמנת: יש לה מועד פרסום שעוד לא הגיע. */
export function isScheduled(episode, now = israelWallClock()) {
  const at = normalizePublishAt(episode?.publishAt);
  return !!at && at > now;
}

/** גלויה לציבור עכשיו: מסומנת גלויה ומועד הפרסום שלה (אם יש) עבר. */
export function isPublic(episode, visible = episode?.visible !== false, now = israelWallClock()) {
  return !!visible && !isScheduled(episode, now);
}
