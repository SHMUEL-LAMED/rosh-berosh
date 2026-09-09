// מפת קודי הניהול בקו. `label` הוא השם הכתוב (באתר ובתיעוד) ו-`spoken` הוא
// הנוסח שהקו מקריא — "להוספת אלבום הקישו 5 1" ולא "הוספת אלבום הקישו 5 1".
// מפת קודי הניהול בקו: כל פעולה מקבלת קוד קבוע בן שתי ספרות, כך שאפשר להגיע
// אליה ישירות מכל מקום בתפריט בלי לחפש בשלוחות. קוד שמסתיים ב-0 הוא נושא,
// 00 מחזיר לתפריט הראשי ו-99 מסיים את השיחה.
const ADMIN_SECTIONS = [
  {
    code: "10",
    label: "קריינויות הקו",
    spoken: "לקריינויות הקו",
    items: [
      { code: "11", label: "הקלטת הודעת מערכת", action: "prompt-system" , spoken: "להקלטת הודעת מערכת" },
      { code: "12", label: "קריינות אלבומים", action: "prompt-albums" , spoken: "לקריינות האלבומים" },
      { code: "13", label: "קריינות שירים לפי אלבום", action: "prompt-songs" , spoken: "לקריינות השירים לפי אלבום" },
      { code: "14", label: "קריינות זמרים", action: "prompt-artists" , spoken: "לקריינות הזמרים" },
      { code: "15", label: "יצירת קריינות אוטומטית לפריט", action: "tts-item" , spoken: "ליצירת קריינות אוטומטית לפריט" },
      { code: "16", label: "יצירת קריינות אוטומטית לכל מה שחסר", action: "tts-missing" , spoken: "ליצירת קריינות אוטומטית לכל מה שחסר" },
      { code: "17", label: "רשימת הקריינויות החסרות", action: "prompts-missing" , spoken: "לשמיעת רשימת הקריינויות החסרות" },
    ],
  },
  {
    code: "20",
    label: "פתיחה וסגירה של ההצבעה",
    spoken: "לפתיחה ולסגירה של ההצבעה",
    items: [
      { code: "21", label: "פתיחת ההצבעה", action: "voting-open" , spoken: "לפתיחת ההצבעה" },
      { code: "22", label: "סגירת ההצבעה", action: "voting-close" , spoken: "לסגירת ההצבעה" },
      { code: "23", label: "בדיקת מוכנות הסקר", action: "voting-readiness" , spoken: "לבדיקת מוכנות הסקר" },
      { code: "24", label: "איפוס כל ההצבעות בסקר הפעיל", action: "voting-reset" , spoken: "לאיפוס כל ההצבעות בסקר הפעיל" },
    ],
  },
  {
    code: "30",
    label: "ניהול הסקרים",
    spoken: "לניהול הסקרים",
    items: [
      { code: "31", label: "הפעלת סקר קיים", action: "survey-activate" , spoken: "להפעלת סקר קיים" },
      { code: "32", label: "יצירת סקר חדש", action: "survey-create" , spoken: "ליצירת סקר חדש" },
      { code: "33", label: "מחיקת סקר", action: "survey-delete" , spoken: "למחיקת סקר" },
      { code: "34", label: "רשימת הסקרים", action: "survey-list" , spoken: "לשמיעת רשימת הסקרים" },
    ],
  },
  {
    code: "40",
    label: "שלבי ההצבעה והכמויות",
    spoken: "לשלבי ההצבעה ולכמויות",
    items: [
      { code: "41", label: "הפעלה או כיבוי של שלב", action: "stage-toggle" , spoken: "להפעלה או לכיבוי של שלב" },
      { code: "42", label: "שינוי מינימום ומקסימום", action: "stage-quota" , spoken: "לשינוי המינימום והמקסימום" },
      { code: "43", label: "שמיעת ההגדרות הנוכחיות", action: "stage-list" , spoken: "לשמיעת ההגדרות הנוכחיות" },
    ],
  },
  {
    code: "50",
    label: "אלבומים שירים וזמרים",
    spoken: "לאלבומים לשירים ולזמרים",
    items: [
      { code: "51", label: "הוספת אלבום", action: "item-create-album" , spoken: "להוספת אלבום" },
      { code: "52", label: "הוספת שיר לאלבום", action: "item-create-song" , spoken: "להוספת שיר לאלבום" },
      { code: "53", label: "הוספת זמר", action: "item-create-artist" , spoken: "להוספת זמר" },
      { code: "54", label: "הפעלה או השבתה של פריט", action: "item-toggle" , spoken: "להפעלה או להשבתה של פריט" },
      { code: "55", label: "הזזת פריט למעלה או למטה", action: "item-move" , spoken: "להזזת פריט למעלה או למטה" },
      { code: "56", label: "העברת פריט למקום מסוים", action: "item-position" , spoken: "להעברת פריט למקום מסוים" },
      { code: "57", label: "מחיקת פריט", action: "item-delete" , spoken: "למחיקת פריט" },
      { code: "58", label: "קטע ההשמעה של שיר באתר", action: "item-preview" , spoken: "לעריכת קטע ההשמעה של שיר באתר" },
      { code: "59", label: "חילוץ עטיפות מקובצי השמע", action: "item-covers" , spoken: "לחילוץ עטיפות מקובצי השמע" },
    ],
  },
  {
    code: "60",
    label: "הרשאות",
    spoken: "להרשאות",
    items: [
      { code: "61", label: "הוספת מספר מורשה לקו", action: "access-add-recorder" , spoken: "להוספת מספר מורשה לקו" },
      { code: "62", label: "הסרת מספר מורשה מהקו", action: "access-remove-recorder" , spoken: "להסרת מספר מורשה מהקו" },
      { code: "63", label: "רשימת המספרים המורשים", action: "access-list-recorders" , spoken: "לשמיעת רשימת המספרים המורשים" },
      { code: "64", label: "רשימת מנהלי האתר", action: "access-list-managers" , spoken: "לשמיעת רשימת מנהלי האתר" },
      { code: "65", label: "הסרת מנהל אתר", action: "access-remove-manager" , spoken: "להסרת מנהל אתר" },
    ],
  },
  {
    code: "70",
    label: "מצב ותוצאות",
    spoken: "למצב ולתוצאות",
    items: [
      { code: "71", label: "סיכום מצב הסקר", action: "status-summary" , spoken: "לסיכום מצב הסקר" },
      { code: "72", label: "האלבומים המובילים", action: "status-albums" , spoken: "לשמיעת האלבומים המובילים" },
      { code: "73", label: "השירים המובילים", action: "status-songs" , spoken: "לשמיעת השירים המובילים" },
      { code: "74", label: "הזמרים המובילים", action: "status-artists" , spoken: "לשמיעת הזמרים המובילים" },
    ],
  },
  {
    code: "80",
    label: "גיבויים",
    spoken: "לגיבויים",
    items: [
      { code: "81", label: "יצירת גיבוי מלא", action: "archive-create" , spoken: "ליצירת גיבוי מלא" },
      { code: "82", label: "שחזור גיבוי", action: "archive-restore" , spoken: "לשחזור גיבוי" },
      { code: "83", label: "מחיקת גיבוי", action: "archive-delete" , spoken: "למחיקת גיבוי" },
      { code: "84", label: "רשימת הגיבויים", action: "archive-list" , spoken: "לשמיעת רשימת הגיבויים" },
    ],
  },
  {
    code: "90",
    label: "עזרה",
    spoken: "לעזרה",
    items: [
      { code: "91", label: "מפת כל קודי הניהול", action: "help-map" , spoken: "לשמיעת מפת כל קודי הניהול" },
      { code: "92", label: "חזרה על התפריט הראשי", action: "help-main" , spoken: "לחזרה לתפריט הראשי" },
    ],
  },
];

const { SEC_WAIT } = require("./menu-input");

const MAIN_MENU_CODE = "00";
const HANGUP_CODE = "99";

function adminItems() {
  return ADMIN_SECTIONS.flatMap((section) => section.items.map((item) => ({ ...item, section })));
}

function findAdminSection(code) {
  return ADMIN_SECTIONS.find((section) => section.code === code) || null;
}

function findAdminItem(code) {
  return adminItems().find((item) => item.code === code) || null;
}

function adminCodes() {
  return [MAIN_MENU_CODE, ...ADMIN_SECTIONS.flatMap((section) => [section.code, ...section.items.map((item) => item.code)]), HANGUP_CODE];
}

// כל התפריטים בקו הניהול קוראים בדיוק שתי ספרות, כדי שלא תהיה המתנה לטיים אאוט.
function adminReadOptions() {
  return { min_digits: 2, max_digits: 2, digits_allowed: adminCodes(), sec_wait: SEC_WAIT, typing_playback_mode: "No" };
}

// ניתוב הקוד שהוקש: נושא, פעולה, חזרה לתפריט הראשי או סיום שיחה.
function resolveAdminCode(code) {
  if (!code || code === HANGUP_CODE) return { type: "hangup" };
  if (code === MAIN_MENU_CODE) return { type: "main" };
  const section = findAdminSection(code);
  if (section) return { type: "section", section };
  const item = findAdminItem(code);
  if (item) return { type: "action", item, section: item.section };
  return { type: "unknown" };
}

module.exports = {
  ADMIN_SECTIONS,
  HANGUP_CODE,
  MAIN_MENU_CODE,
  adminCodes,
  adminItems,
  adminReadOptions,
  findAdminItem,
  findAdminSection,
  resolveAdminCode,
};
