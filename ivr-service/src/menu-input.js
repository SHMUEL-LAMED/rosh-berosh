// כמה שניות ימות המשיח ממתינים להקשה לפני שהם מוותרים ומנתקים. ברירת המחדל
// של המערכת היא 7 שניות, קצר מדי לתפריט שמקריא רשימה שלמה, ולכן המתקשר נותק
// באמצע. אפשר לכוונן דרך IVR_SEC_WAIT.
const SEC_WAIT = Math.min(Math.max(Number(process.env.IVR_SEC_WAIT) || 20, 7), 60);

function menuReadOptions(digits) {
  return {
    min_digits: 1,
    max_digits: 1,
    digits_allowed: digits,
    sec_wait: SEC_WAIT,
    typing_playback_mode: "No",
  };
}

// אחרי הקשה ראשונה הקו ממתין רק את הזמן הזה כדי לראות אם באה עוד ספרה, וכך
// אפשר להקיש 1 ולא 01. סולמית מסיימת מיד. אפשר לכוונן דרך IVR_MENU_SEC_WAIT.
const MENU_SEC_WAIT = Math.min(Math.max(Number(process.env.IVR_MENU_SEC_WAIT) || 5, 2), 20);

// תפריטי קו הניהול: המספר נאמר ומוקש כמספר טבעי, בלי ריפוד באפסים. בקו
// ההצבעה נשאר אורך קבוע, כי הקריינויות המוקלטות של התפריטים אומרות את
// הקודים המרופדים ("הקישו אפס אחת"), והחלפה כאן הייתה סותרת אותן.
function naturalMenuInput(itemCount, allowFinish = false) {
  const width = String(itemCount).length;
  const digitsAllowed = Array.from({ length: itemCount }, (_, index) => String(index + 1));
  if (allowFinish) digitsAllowed.unshift("0");
  return {
    width,
    finishCode: "0",
    code: (index) => String(index + 1),
    read: {
      min_digits: 1,
      max_digits: width,
      digits_allowed: digitsAllowed,
      sec_wait: MENU_SEC_WAIT,
      typing_playback_mode: "No",
    },
  };
}

function menuCodeWidth(itemCount) {
  return itemCount > 9 ? String(itemCount).length : 1;
}

function menuCode(index, width) {
  return String(index + 1).padStart(width, "0");
}

function continuousMenuInput(itemCount, allowFinish = false) {
  const width = menuCodeWidth(itemCount);
  const finishCode = "0".repeat(width);
  const digitsAllowed = Array.from({ length: itemCount }, (_, index) => menuCode(index, width));
  if (allowFinish) digitsAllowed.unshift(finishCode);
  return {
    width,
    finishCode,
    read: {
      min_digits: width,
      max_digits: width,
      digits_allowed: digitsAllowed,
      sec_wait: SEC_WAIT,
      typing_playback_mode: "No",
    },
  };
}

module.exports = { MENU_SEC_WAIT, SEC_WAIT, continuousMenuInput, menuCode, menuCodeWidth, menuReadOptions, naturalMenuInput };
