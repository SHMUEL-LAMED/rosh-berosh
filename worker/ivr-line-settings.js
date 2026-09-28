// הגדרות הקו הטלפוני שנקבעות מהאתר: לאן מעבירים בסיום השיחה, כמה זמן ממתינים
// להקשה ובכמה פעמים חוזרים על תפריט שלא הוקש בו דבר. הן נשמרות כשורת JSON אחת
// ב-ivr_store_meta, טבלת הקו שכבר קיימת, כך שאין צורך בטבלה או במיגרציה חדשה.
// ערך שלא נקבע נשאר null (או "" במספר ההעברה), ושירות הקו נופל אז למשתני
// הסביבה שלו ואחריהם לברירות המחדל הקבועות — כלומר בלי הגדרה באתר הקו מתנהג
// בדיוק כמו קודם.

export const LINE_SETTINGS_KEY = "line-settings";

// ברירות המחדל הקבועות של שירות הקו (ivr-service/src/line-settings.js). הן
// מוצגות במסך הניהול כשלא נקבע ערך, ושתי הרשימות נבדקות יחד בבדיקות.
export const LINE_SETTINGS_DEFAULTS = Object.freeze({
  postVoteTransfer: "0796077075",
  votingWaitSeconds: 20,
  adminWaitSeconds: 5,
  menuRepeats: 0,
});

// אותם גבולות שהשירות מחיל על משתני הסביבה IVR_SEC_WAIT ו-IVR_MENU_SEC_WAIT.
// פחות מ-7 שניות בתפריט הצבעה מנתק מתקשרים באמצע רשימה ארוכה, ויותר מחמש
// חזרות משאיר קו פתוח סתם.
export const LINE_SETTINGS_LIMITS = Object.freeze({
  votingWaitSeconds: Object.freeze({ min: 7, max: 60 }),
  adminWaitSeconds: Object.freeze({ min: 2, max: 20 }),
  menuRepeats: Object.freeze({ min: 0, max: 5 }),
});

const NUMERIC_KEYS = ["votingWaitSeconds", "adminWaitSeconds", "menuRepeats"];

const LABELS = {
  votingWaitSeconds: "זמן ההמתנה בתפריטי ההצבעה",
  adminWaitSeconds: "זמן ההמתנה בתפריטי הניהול",
  menuRepeats: "מספר החזרות על תפריט",
};

export const TRANSFER_ERROR = "מספר ההעברה חייב להיות מספר טלפון ישראלי בן 9 או 10 ספרות שמתחיל ב־0 (לדוגמה 0796077075), או off לכיבוי ההעברה.";

/** מה שנשמר כשעדיין לא נקבע דבר: הכול לפי ברירת המחדל של שירות הקו. */
export function emptyLineSettings() {
  return { transferNumber: "", transferEnabled: true, votingWaitSeconds: null, adminWaitSeconds: null, menuRepeats: null };
}

function parseTransferNumber(value) {
  if (value === undefined || value === null) return { value: "" };
  if (typeof value !== "string" && typeof value !== "number") return { error: TRANSFER_ERROR };
  const trimmed = String(value).trim();
  if (!trimmed) return { value: "" };
  // רווחים ומקפים הם עיצוב בלבד ("079-607-7075"). כל תו אחר — אותיות, פלוס,
  // קידומת בינלאומית — נדחה, כי ימות המשיח מקבלת כאן ספרות בלבד.
  const digits = trimmed.replace(/[\s-]/g, "");
  return /^0\d{8,9}$/.test(digits) ? { value: digits } : { error: TRANSFER_ERROR };
}

function parseTransfer(value) {
  if (typeof value === "string" && /^\s*off\s*$/i.test(value)) return { off: true, value: "" };
  return parseTransferNumber(value);
}

function parseInteger(key, value) {
  if (value === undefined || value === null || value === "") return { value: null };
  let number = Number.NaN;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) number = Number(value);
  const { min, max } = LINE_SETTINGS_LIMITS[key];
  if (!Number.isInteger(number) || number < min || number > max) {
    return { error: `${LABELS[key]} חייב להיות מספר שלם בין ${min} ל־${max}.` };
  }
  return { value: number };
}

/**
 * בודק בקשת שמירה מהאתר וממזג אותה על ההגדרות הקיימות. שדה שלא נשלח נשאר
 * כמות שהוא; null או "" מחזירים אותו לברירת המחדל.
 *
 * - `postVoteTransfer`: מספר טלפון (9–10 ספרות, מתחיל ב-0), "off" לכיבוי,
 *   או "" לברירת המחדל. "off" שומר את המספר האחרון, כדי שהדלקה מחדש לא תדרוש
 *   להקליד אותו שוב.
 * - `transferNumber`: המספר שנזכר גם כשההעברה כבויה (אופציונלי).
 * - `votingWaitSeconds`, `adminWaitSeconds`, `menuRepeats`: מספרים שלמים בגבולות.
 *
 * מחזיר `{ settings }` או `{ error }` בעברית.
 */
export function validateLineSettings(body, current = emptyLineSettings()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "פרטי ההגדרות אינם תקינים." };
  const settings = { ...emptyLineSettings(), ...current };
  if (body.transferNumber !== undefined) {
    const parsed = parseTransferNumber(body.transferNumber);
    if (parsed.error) return { error: parsed.error };
    settings.transferNumber = parsed.value;
  }
  if (body.postVoteTransfer !== undefined) {
    const parsed = parseTransfer(body.postVoteTransfer);
    if (parsed.error) return { error: parsed.error };
    if (parsed.off) settings.transferEnabled = false;
    else { settings.transferEnabled = true; settings.transferNumber = parsed.value; }
  }
  for (const key of NUMERIC_KEYS) {
    if (body[key] === undefined) continue;
    const parsed = parseInteger(key, body[key]);
    if (parsed.error) return { error: parsed.error };
    settings[key] = parsed.value;
  }
  return { settings };
}

/** הערך שהקו מקבל: "off", מספר, או "" (ברירת המחדל של השירות). */
export function postVoteTransferOf(settings) {
  if (settings?.transferEnabled === false) return "off";
  return settings?.transferNumber || "";
}

/**
 * קורא את השורה השמורה. שורה פגומה, או ערך שיצא מהגבולות (למשל אחרי שינוי
 * בגבולות), אינם מפילים את הקו: השדה הפגום נחשב כלא נקבע.
 */
export function parseStoredLineSettings(raw) {
  let stored = null;
  try { stored = typeof raw === "string" && raw ? JSON.parse(raw) : null; }
  catch { stored = null; }
  const settings = emptyLineSettings();
  if (!stored || typeof stored !== "object") return { settings, updatedAt: null, updatedBy: null };
  const number = parseTransferNumber(stored.transferNumber);
  if (!number.error) settings.transferNumber = number.value;
  settings.transferEnabled = stored.transferEnabled !== false;
  for (const key of NUMERIC_KEYS) {
    const parsed = parseInteger(key, stored[key]);
    if (!parsed.error) settings[key] = parsed.value;
  }
  const updatedAt = Number.isFinite(Number(stored.updatedAt)) && stored.updatedAt ? Number(stored.updatedAt) : null;
  const updatedBy = typeof stored.updatedBy === "string" && stored.updatedBy ? stored.updatedBy : null;
  return { settings, updatedAt, updatedBy };
}

/** מה שנשלח לשירות הקו: רק הערכים שנקבעו באתר, והשאר null. */
export function lineSettingsForIvr(settings) {
  return {
    postVoteTransfer: postVoteTransferOf(settings),
    votingWaitSeconds: settings.votingWaitSeconds ?? null,
    adminWaitSeconds: settings.adminWaitSeconds ?? null,
    menuRepeats: settings.menuRepeats ?? null,
  };
}

/**
 * התמונה שמסך הניהול מציג: הערך בפועל ומאיפה הוא בא. האתר אינו רואה את משתני
 * הסביבה של שרת הקו, ולכן "default" פירושו ברירת המחדל של השרת — שהיא הערך
 * הקבוע, אלא אם הוגדר בשרת משתנה סביבה אחר.
 */
export function describeLineSettings(settings) {
  const ivr = lineSettingsForIvr(settings);
  const transferSet = ivr.postVoteTransfer !== "";
  const effective = {
    postVoteTransfer: ivr.postVoteTransfer === "off" ? "" : ivr.postVoteTransfer || LINE_SETTINGS_DEFAULTS.postVoteTransfer,
    transferEnabled: ivr.postVoteTransfer !== "off",
  };
  const sources = { postVoteTransfer: transferSet ? "admin" : "default" };
  for (const key of NUMERIC_KEYS) {
    effective[key] = ivr[key] ?? LINE_SETTINGS_DEFAULTS[key];
    sources[key] = ivr[key] === null ? "default" : "admin";
  }
  return { settings: { ...ivr, transferNumber: settings.transferNumber || "" }, effective, sources, defaults: LINE_SETTINGS_DEFAULTS, limits: LINE_SETTINGS_LIMITS };
}
