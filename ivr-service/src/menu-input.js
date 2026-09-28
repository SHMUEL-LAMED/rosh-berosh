const { resolveLineSettings, withMenuRepeats } = require("./line-settings");

// ההגדרות לפי משתני הסביבה בלבד, כפי שהיו עד שנוספה ההגדרה מהאתר. כל פונקציה
// כאן מקבלת את הגדרות השיחה (מהאתר, ראו line-settings.js) ונופלת לאלה כשלא
// הועברו.
const ENV_TIMING = resolveLineSettings(null, process.env);

// כמה שניות ימות המשיח ממתינים להקשה לפני שהם מוותרים ומנתקים. ברירת המחדל
// של המערכת היא 7 שניות, קצר מדי לתפריט שמקריא רשימה שלמה, ולכן המתקשר נותק
// באמצע. נקבע במסך הניהול באתר, ובלעדיו ב-IVR_SEC_WAIT (ברירת מחדל 20).
const SEC_WAIT = ENV_TIMING.votingWaitSeconds;

// תפריט של ספרה אחת. משמש גם את שאלות האישור והרשימות הקצרות בקו הניהול,
// ולכן גם שם ההמתנה היא זו של תפריטי ההצבעה, כפי שהיה תמיד.
function menuReadOptions(digits, timing = ENV_TIMING) {
  return withMenuRepeats({
    min_digits: 1,
    max_digits: 1,
    digits_allowed: digits,
    sec_wait: timing.votingWaitSeconds,
    typing_playback_mode: "No",
  }, timing.menuRepeats);
}

// תפריט הקשה כללי בקו ההצבעה (תפריט השלבים, אישור ההצבעה, אישור ההעברה):
// אותה המתנה ואותן חזרות כמו רשימות ההצבעה.
function votingReadOptions(options, timing = ENV_TIMING) {
  return withMenuRepeats({ ...options, sec_wait: timing.votingWaitSeconds }, timing.menuRepeats);
}

// אחרי הקשה ראשונה הקו ממתין רק את הזמן הזה כדי לראות אם באה עוד ספרה, וכך
// אפשר להקיש 1 ולא 01. סולמית מסיימת מיד. נקבע במסך הניהול באתר, ובלעדיו
// ב-IVR_MENU_SEC_WAIT (ברירת מחדל 5).
const MENU_SEC_WAIT = ENV_TIMING.adminWaitSeconds;

// תפריטי קו הניהול: המספר נאמר ומוקש כמספר טבעי, בלי ריפוד באפסים. בקו
// ההצבעה נשאר אורך קבוע, כי הקריינויות המוקלטות של התפריטים אומרות את
// הקודים המרופדים ("הקישו אפס אחת"), והחלפה כאן הייתה סותרת אותן.
function naturalMenuInput(itemCount, allowFinish = false, timing = ENV_TIMING) {
  const width = String(itemCount).length;
  const digitsAllowed = Array.from({ length: itemCount }, (_, index) => String(index + 1));
  if (allowFinish) digitsAllowed.unshift("0");
  return {
    width,
    finishCode: "0",
    code: (index) => String(index + 1),
    read: withMenuRepeats({
      min_digits: 1,
      max_digits: width,
      digits_allowed: digitsAllowed,
      sec_wait: timing.adminWaitSeconds,
      typing_playback_mode: "No",
    }, timing.menuRepeats),
  };
}

function menuCodeWidth(itemCount) {
  return itemCount > 9 ? String(itemCount).length : 1;
}

function menuCode(index, width) {
  return String(index + 1).padStart(width, "0");
}

function continuousMenuInput(itemCount, allowFinish = false, timing = ENV_TIMING) {
  const width = menuCodeWidth(itemCount);
  const finishCode = "0".repeat(width);
  const digitsAllowed = Array.from({ length: itemCount }, (_, index) => menuCode(index, width));
  if (allowFinish) digitsAllowed.unshift(finishCode);
  return {
    width,
    finishCode,
    read: withMenuRepeats({
      min_digits: width,
      max_digits: width,
      digits_allowed: digitsAllowed,
      sec_wait: timing.votingWaitSeconds,
      typing_playback_mode: "No",
    }, timing.menuRepeats),
  };
}

// ימות המשיח מקצה את הסולמית למקש "סיום הקשה", ולכן אי אפשר לקלוט אותה
// כספרה: הקשה עליה לבדה מגיעה לקו כהקשה ריקה. תפריט שמבקש הקשה ריקה מפורשת
// עם ערך מזוהה יכול לזהות אותה, והקו מעביר את המתקשר ליעד. אין דרך להבחין
// בין סולמית לבין מי שלא הקיש כלום עד תום ההמתנה: שניהם מגיעים כאותו ערך.
const TRANSFER_KEY = "hashkey";

// בלי יעד העברה אין לאן להעביר, ולכן התפריט נשאר בהתנהגות המקורית: הקשה
// ריקה מבקשת בחירה מחדש במקום להוציא את המתקשר מההצבעה.
function transferOnEmptyEntry(options, transferTarget) {
  return transferTarget ? { ...options, allow_empty: true, empty_val: TRANSFER_KEY } : options;
}

module.exports = { ENV_TIMING, MENU_SEC_WAIT, SEC_WAIT, TRANSFER_KEY, continuousMenuInput, menuCode, menuCodeWidth, menuReadOptions, naturalMenuInput, transferOnEmptyEntry, votingReadOptions };
