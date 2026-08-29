// מפת קודי הניהול בקו: כל פעולה מקבלת קוד קבוע בן שתי ספרות, כך שאפשר להגיע
// אליה ישירות מכל מקום בתפריט בלי לחפש בשלוחות. קוד שמסתיים ב-0 הוא נושא,
// 00 מחזיר לתפריט הראשי ו-99 מסיים את השיחה.
const ADMIN_SECTIONS = [
  {
    code: "10",
    label: "קריינויות הקו",
    items: [
      { code: "11", label: "הקלטת הודעת מערכת", action: "prompt-system" },
      { code: "12", label: "קריינות אלבומים", action: "prompt-albums" },
      { code: "13", label: "קריינות שירים לפי אלבום", action: "prompt-songs" },
      { code: "14", label: "קריינות זמרים", action: "prompt-artists" },
      { code: "15", label: "יצירת קריינות אוטומטית לפריט", action: "tts-item" },
      { code: "16", label: "יצירת קריינות אוטומטית לכל מה שחסר", action: "tts-missing" },
      { code: "17", label: "רשימת הקריינויות החסרות", action: "prompts-missing" },
    ],
  },
  {
    code: "20",
    label: "פתיחה וסגירה של ההצבעה",
    items: [
      { code: "21", label: "פתיחת ההצבעה", action: "voting-open" },
      { code: "22", label: "סגירת ההצבעה", action: "voting-close" },
      { code: "23", label: "בדיקת מוכנות הסקר", action: "voting-readiness" },
      { code: "24", label: "איפוס כל ההצבעות בסקר הפעיל", action: "voting-reset" },
    ],
  },
  {
    code: "30",
    label: "ניהול הסקרים",
    items: [
      { code: "31", label: "הפעלת סקר קיים", action: "survey-activate" },
      { code: "32", label: "יצירת סקר חדש", action: "survey-create" },
      { code: "33", label: "מחיקת סקר", action: "survey-delete" },
      { code: "34", label: "רשימת הסקרים", action: "survey-list" },
    ],
  },
  {
    code: "40",
    label: "שלבי ההצבעה והכמויות",
    items: [
      { code: "41", label: "הפעלה או כיבוי של שלב", action: "stage-toggle" },
      { code: "42", label: "שינוי מינימום ומקסימום", action: "stage-quota" },
      { code: "43", label: "שמיעת ההגדרות הנוכחיות", action: "stage-list" },
    ],
  },
  {
    code: "50",
    label: "אלבומים שירים וזמרים",
    items: [
      { code: "51", label: "הוספת אלבום", action: "item-create-album" },
      { code: "52", label: "הוספת שיר לאלבום", action: "item-create-song" },
      { code: "53", label: "הוספת זמר", action: "item-create-artist" },
      { code: "54", label: "הפעלה או השבתה של פריט", action: "item-toggle" },
      { code: "55", label: "הזזת פריט למעלה או למטה", action: "item-move" },
      { code: "56", label: "העברת פריט למקום מסוים", action: "item-position" },
      { code: "57", label: "מחיקת פריט", action: "item-delete" },
      { code: "58", label: "קטע ההשמעה של שיר באתר", action: "item-preview" },
      { code: "59", label: "חילוץ עטיפות מקובצי השמע", action: "item-covers" },
    ],
  },
  {
    code: "60",
    label: "הרשאות",
    items: [
      { code: "61", label: "הוספת מספר מורשה לקו", action: "access-add-recorder" },
      { code: "62", label: "הסרת מספר מורשה מהקו", action: "access-remove-recorder" },
      { code: "63", label: "רשימת המספרים המורשים", action: "access-list-recorders" },
      { code: "64", label: "רשימת מנהלי האתר", action: "access-list-managers" },
      { code: "65", label: "הסרת מנהל אתר", action: "access-remove-manager" },
    ],
  },
  {
    code: "70",
    label: "מצב ותוצאות",
    items: [
      { code: "71", label: "סיכום מצב הסקר", action: "status-summary" },
      { code: "72", label: "האלבומים המובילים", action: "status-albums" },
      { code: "73", label: "השירים המובילים", action: "status-songs" },
      { code: "74", label: "הזמרים המובילים", action: "status-artists" },
    ],
  },
  {
    code: "80",
    label: "גיבויים",
    items: [
      { code: "81", label: "יצירת גיבוי מלא", action: "archive-create" },
      { code: "82", label: "שחזור גיבוי", action: "archive-restore" },
      { code: "83", label: "מחיקת גיבוי", action: "archive-delete" },
      { code: "84", label: "רשימת הגיבויים", action: "archive-list" },
    ],
  },
  {
    code: "90",
    label: "עזרה",
    items: [
      { code: "91", label: "מפת כל קודי הניהול", action: "help-map" },
      { code: "92", label: "חזרה על התפריט הראשי", action: "help-main" },
    ],
  },
];

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
  return { min_digits: 2, max_digits: 2, digits_allowed: adminCodes(), typing_playback_mode: "No" };
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
