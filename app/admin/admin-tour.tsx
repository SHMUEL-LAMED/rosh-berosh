"use client";

/* סיור הדרכה בניהול אתר התוכניות: עובר על המסך האמיתי צעד אחרי צעד — עובר ללשונית
   הנכונה, מאיר את הכפתור או האזור עצמו (כל השאר מוחשך) ומסביר מה עושים בו.
   שלושה סוגים: קצר (החלקים הראשיים), מקיף (כל כפתור וכל שדה בכל החלקים), והסבר על
   חלק אחד (הכפתור „?” ליד הכותרת). בפעם הראשונה שמנהל נכנס לחלק "אתר התוכניות"
   נפתחת הבחירה בין הקצר למקיף (נשמר במכשיר); מהתפריט אפשר לפתוח אותה שוב.
   אין בו שום פעולה על הנתונים — לכל היותר בחירה של תוכנית או אורח כדי להראות את העורך. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./admin-tour.css";

/** צעד בסיור. `target` — הבורר של האזור שמאירים (בלי — הכרטיס במרכז המסך).
    `click` — לפני ההארה לוחצים על זה, אם האזור עוד לא על המסך (בחירת תוכנית או אורח מהרשימה — בחירה בלבד, בלי שינוי).
    `open` — פותחים את ה־<details> הזה (למשל "עוד פרטים"). אין צעד שמשנה נתונים. */
export type TourStep = { tab?: string; target?: string; click?: string; open?: string; title: string; body: string };

/** הסיור הקצר — דקה על החלקים הראשיים */
export const SHORT_TOUR: TourStep[] = [
  { tab: "prog-programs", title: "ברוכים הבאים לניהול אתר התוכניות", body: "סיור קצר של דקה על המסך האמיתי: איפה מוסיפים תוכנית, איך משלימים פרטים, ואיך הכול עולה לאתר. אפשר לדלג בכל רגע ולחזור לסיור מהתפריט." },
  { tab: "prog-programs", target: '[data-tour="nav-programs"]', title: "החלקים של אתר התוכניות", body: "תוכניות, אורחים, ניקוי פרסומות, הודעות לאתר, סקרים, מאזינים ופרסום — כל חלק במקום אחד בתפריט. הלשונית הפתוחה נשמרת בכתובת, כך שאפשר לשלוח קישור ישר אליה." },
  { tab: "prog-programs", target: ".prog-status", title: "טיוטה שנשמרת לבד", body: "כל שינוי נשמר אוטומטית בטיוטה משותפת בשרת — אפשר להתחיל במחשב ולהמשיך בטלפון. הפס הזה אומר אם יש שינויים שעוד לא עלו לאתר." },
  { tab: "prog-programs", target: '[data-tour="prog-new"]', title: "תוכנית חדשה", body: "לחיצה כאן פותחת תוכנית חדשה עם המספר הבא ותאריך של היום. אחר כך מעלים את ההקלטה, והאורך נקרא מהקובץ לבד." },
  { tab: "prog-programs", target: '[data-tour="prog-find"]', title: "חיפוש, סינון ובחירה מרובה", body: "מוצאים תוכנית לפי שם, מסננים (מוסתרות, מתוזמנות, בלי הקלטה) — וב„בחירה מרובה” מסתירים, מציגים או משייכים לעונה כמה תוכניות יחד." },
  { tab: "prog-programs", target: ".prog-editor", title: "העורך", body: "לחיצה על תוכנית ברשימה פותחת אותה כאן: שם, תאריך, אורחים, הקלטה ותמונה. הבינה המלאכותית מתמללת וכותבת תיאור, ויש פרסום מתוזמן ותצוגה חיה של הדף." },
  { tab: "prog-guests", target: '[data-tour="guests-scan"]', title: "אורחים", body: "שמות האורחים בדפי התוכניות באתר מובילים לארכיון המסונן לפי האורח. כאן משנים שמות ומאחדים כפילויות — והכפתור הזה אוסף מהתמלולים את כל מי שהתארח, כדי להשלים את התוכניות בלחיצה." },
  { tab: "prog-site", target: "#tour-banner", title: "הודעה בראש האתר", body: "„התוכנית הבאה ביום חמישי” או ברכה לחג — פס הודעה בראש כל הדפים, שנעלם לבד בתאריך שבוחרים. מתחת: דף העדכונים, פרטי הקשר והעונות." },
  { tab: "prog-listeners", target: "#tour-messages", title: "המאזינים", body: "מה שמאזינים כתבו לכם ותגובות מדפי התוכניות — בתיבה אחת. למעלה: כמה מאזינים, מה הכי נשמע ועד איפה שומעים; ולמטה שליחת התראה לכל המאזינים." },
  { tab: "prog-publish", target: "#tour-publish", title: "הפרסום", body: "כאן רואים מה השתנה ומעלים הכול לאתר בלחיצה אחת. בדיקת התקינות מסמנת מה חסר (ומתקנת בלחיצה), וכל פרסום נשמר כגרסה שאפשר לחזור אליה." },
  { target: '[data-tour="section-help"]', title: "עזרה בכל חלק", body: "הכפתור „?” ליד הכותרת מסביר את החלק שאתם נמצאים בו — כל כפתור וכל שדה. והסיורים, הקצר והמקיף, תמיד בתפריט." },
];

const PICK_EPISODE = '[data-tour="prog-items"] .prog-item';
const PICK_GUEST = '[data-tour="guests-list"] .prog-item';

/** הסבר מפורט לכל חלק — הכפתור „?” בכל חלק מריץ את החלק שלו, והסיור המקיף את כולם ברצף */
export const SECTION_TOURS: Record<string, TourStep[]> = {
  "prog-programs": [
    { target: '[data-tour="prog-new"]', title: "תוכנית חדשה", body: "פותחת תוכנית עם המספר הבא, התאריך של היום והעונה הראשונה ברשימה. היא נשמרת בטיוטה ומגיעה לאתר רק בפרסום. אפשר גם לגרור קובץ הקלטה או תמונה לעורך של תוכנית קיימת." },
    { target: '[data-tour="prog-find"]', title: "חיפוש וסינון", body: "החיפוש עובד על שם, תיאור, מספר, תאריך, אורחים ומילות חיפוש. הסינון מציג רק מוצגות, מוסתרות, מתוזמנות או תוכניות בלי הקלטה. „בחירה מרובה” מאפשרת להציג, להסתיר, לשייך לעונה או למחוק כמה תוכניות בבת אחת." },
    { target: '[data-tour="prog-items"]', title: "רשימת התוכניות", body: "מהחדשה לישנה. ליד כל תוכנית: התאריך, והמצב — ירוק „מוצגת”, ורוד „מוסתרת”, כחול „מתוזמנת”; ★ היא המומלצת בדף הבית. לחיצה פותחת אותה בעורך." },
    { click: PICK_EPISODE, target: '[data-tour="ed-actions"]', title: "הכפתורים של התוכנית", body: "„צפייה באתר” פותח את הדף שלה. „טקסט לוואטסאפ” מעתיק הודעה מוכנה, ו„מייל למאזינים” פותח טיוטת מייל לרשימת התפוצה. „שכפול” יוצר עותק, „גרסאות קודמות” מראה איך היא נראתה בכל פרסום (ומחזיר גרסה בלחיצה), ו„מחיקה” — עם אפשרות ביטול." },
    { click: PICK_EPISODE, target: '[data-tour="ed-details"]', title: "פרטי התוכנית", body: "שם, תאריך שידור, מספר ועונה (אפשר גם ליצור עונה חדשה מהרשימה). כל שינוי נשמר בטיוטה תוך שנייה — אין כפתור „שמירה”." },
    { click: PICK_EPISODE, target: '[data-tour="ed-guests"]', title: "אורחים", body: "שמות מופרדים בפסיק. כל שם הופך באתר לקישור לארכיון המסונן לפי האורח, עם כל התוכניות שלו. שינוי שם בכל התוכניות ואיחוד כפילויות — בחלק „אורחים”." },
    { click: PICK_EPISODE, target: '[data-tour="ed-desc"]', title: "על התוכנית", body: "כמה משפטים שמופיעים בדף התוכנית ובכרטיס שלה. אין לכם כוח לכתוב? הכרטיס של הבינה המלאכותית למטה כותב תיאור מהתמלול." },
    { click: PICK_EPISODE, target: '[data-tour="ed-survey"]', title: "קישור למצעד", body: "אם התוכנית שייכת למצעד מסוים, בוחרים אותו כאן. כשהמצעד הזה הוא הפעיל, בדף התוכנית מופיע פס שמזמין להצביע בו." },
    { click: PICK_EPISODE, target: '[data-tour="ed-schedule"]', title: "פרסום מתוזמן", body: "קובעים תאריך ושעה (שעון ישראל), והתוכנית תופיע באתר לבד ברגע הזה — גם אם אף אחד לא מחובר. עד אז היא לא גלויה למאזינים." },
    { click: PICK_EPISODE, target: '[data-tour="ed-switches"]', title: "מוצגת ומומלצת", body: "„מוצגת באתר” — האם המאזינים רואים אותה. „המומלצת בדף הבית” — התוכנית הגדולה בראש דף הבית (רק אחת בכל פעם)." },
    { click: PICK_EPISODE, target: "#tour-ed-audio", title: "ההקלטה", body: "מעלים קובץ (עד 1GB — קובץ גדול עולה בחלקים, ואפשר להמשיך לעבוד בינתיים) או מדביקים קישור, גם לדרייב. האורך נקרא מהקובץ לבד, והנגן כאן מאפשר לבדוק שהכול תקין." },
    { click: PICK_EPISODE, target: "#tour-ed-cover", title: "התמונה", body: "„ליצור תמונה עכשיו” מצייר עטיפה בסגנון האתר עם שם התוכנית. אפשר גם להעלות תמונה משלכם או לגרור אותה לכאן — נשמרת אוטומטית גם גרסה קטנה, כדי שהאתר ייטען מהר." },
    { click: PICK_EPISODE, open: '[data-tour="ed-more"]', target: '[data-tour="ed-more"]', title: "עוד פרטים", body: "מילות חיפוש שעוזרות למאזינים למצוא את התוכנית, כתובת הדף (אם רוצים כתובת יפה יותר), וקישורים שיופיעו בדף — פלייליסט, אלבום או כל דבר אחר." },
    { click: PICK_EPISODE, target: '[data-tour="ed-ai"]', title: "הבינה המלאכותית", body: "מופיעה כשיש הקלטה: מתמללת את התוכנית (גם לבד, ברקע), כותבת תיאור, סיכום ומילות חיפוש, ומציעה שמות לתוכנית. שום דבר לא נכנס בלי שתאשרו." },
  ],
  "prog-guests": [
    { target: '[data-tour="guests-scan"]', title: "השלמת אורחים מהתמלולים", body: "בסיכום של כל תמלול כבר רשום מי התארח. הכפתור אוסף את כולם ומציע להוסיף לכל תוכנית רק את מי שחסר בה. שם שנראה כמו אחד המגישים מוצע בלי סימון. מוסיפים רק את מה שמסמנים." },
    { target: '[data-tour="guests-list"]', title: "כל האורחים", body: "כל מי שמופיע בשדה „אורחים” או „חברי פאנל” של התוכניות, מהרבות למעטות. „כמה כתיבים” — השם נכתב בכמה צורות, וכדאי לאחד." },
    { click: PICK_GUEST, target: "#tour-guest-editor", title: "השם והתפקיד", body: "שינוי השם כאן מחליף אותו בכל התוכניות; שם של אורח קיים מאחד את השניים. „חבר פאנל” בתפקיד מוסיף אותו לתוכניות כחבר פאנל, וכל תפקיד אחר — כאורח." },
    { click: PICK_GUEST, target: "#tour-guest-episodes", title: "התוכניות של האורח", body: "כל התוכניות שהאורח מופיע בהן. מכאן אפשר להוסיף אותו לתוכנית נוספת, לאחד אותו עם אורח אחר, או להסיר אותו מכל התוכניות." },
  ],
  "prog-ads": [
    { target: '[data-tour="ads"]', title: "ניקוי פרסומות", body: "הסריקה עוברת על התמלולים ומסמנת משפטים שנשמעים כמו פרסומת. שום דבר לא נחתך לבד: מאזינים לכל הצעה, מכוונים את הגבולות ומסמנים רק את מה שבאמת צריך לרדת." },
    { target: '[data-tour="ads-pick"]', title: "בדיקת תוכנית", body: "בוחרים תוכנית, מאזינים לקטעים החשודים (▶ קופץ חמש שניות לפני), ו„התחלה עכשיו” / „סוף עכשיו” מעתיקים את מיקום הנגן. בסוף — „אישור חיתוך”, ונוצר קובץ חדש; המקור לא נמחק. אחר כך מפרסמים." },
  ],
  "prog-site": [
    { target: "#tour-banner", title: "הודעה בראש האתר", body: "פס הודעה בראש כל הדפים — „התוכנית הבאה ביום חמישי” או ברכה לחג. אפשר להוסיף קישור וכפתור, לבחור אם להציג גם באתר הסקר, ולקבוע תאריך שבו היא נעלמת לבד." },
    { target: "#tour-updates", title: "דף העדכונים", body: "הודעות קצרות למאזינים בדף „עדכונים”. החדש למעלה, ואפשר לנעוץ עדכון חשוב. עדכון מהחודש האחרון מוסיף את „עדכונים” לתפריט האתר, עם סימון „חדש”." },
    { target: "#tour-contacts", title: "פרטי קשר", body: "הטלפונים, המייל וההערות שמופיעים בדף הבית של האתר." },
    { target: "#tour-seasons", title: "עונות", body: "העונות מסדרות את הארכיון. משנים שם, מוסיפים עונה חדשה, ורואים כמה תוכניות יש בכל אחת." },
  ],
  "prog-polls": [
    { target: '[data-tour="polls-new"]', title: "סקר חדש", body: "שאלה למאזינים עם תשובות — אפשר עם תמונה לכל תשובה, ויש תבניות מוכנות. בוחרים איפה הסקר מוצג (דף הבית, הארכיון, האזור האישי או דפי תוכניות), מתי הוא נפתח ונסגר בשעון ישראל, ומי רואה את התוצאות. הסקר נשמר בטיוטה ועולה לאתר בפרסום." },
    { target: '[data-tour="polls-list"]', title: "הסקרים באתר", body: "כל הסקרים, עם המצב של כל אחד — פתוח, ייפתח, נסגר, כבוי או חסרים פרטים — ואיפה הוא מוצג. „עריכה” פותחת את הסקר, „שכפול” יוצר עותק כבוי, ו־✕ מוחק אותו מהטיוטה (ההצבעות נשארות בשרת)." },
    { target: '[data-tour="polls-results"]', title: "תוצאות חיות ואיפוס", body: "ליד כל סקר מופיע כמה מאזינים הצביעו וכמה קיבלה כל תשובה, ישר מהשרת. התוצאות מתעדכנות לבד כל 30 שניות, ו„רענון” מעדכן מיד. „איפוס הצבעות” מוחק את כל ההצבעות של סקר — מיד, ואחרי אישור." },
  ],
  "prog-listeners": [
    { target: "#tour-stats", title: "מי מאזין", body: "האזנות ומאזינים בשבוע האחרון, גרף של 30 יום, והתוכניות הכי נשמעות. האזנה נספרת רק אחרי כמה דקות — את הסף משנים ב„מה נספר”. בטבלה: לכל תוכנית כמה שמעו עד הסוף, הורדות, ומאיפה הגיעו." },
    { target: "#tour-messages", title: "הודעות מהמאזינים", body: "מה שנכתב ב„כתבו לנו” באתר. אפשר לסמן כנקרא, לענות במייל ולמחוק. המספר האדום — כמה עוד לא נקראו." },
    { target: "#tour-comments", title: "תגובות באתר", body: "תגובות מדפי התוכניות. „אישור והצגה” מעלה תגובה לאתר; אפשר גם להסתיר, למחוק או לכתוב תשובה בשם התוכנית. „ממתינות” — עוד לא טופלו." },
    { target: "#tour-push", title: "התראות לטלפון", body: "שליחת התראה לכל מי שהפעיל התראות באתר — למשל „התוכנית החדשה עלתה!”. ההתראות נשלחות במנות, אז לרשימה ארוכה זה לוקח כמה דקות." },
    { target: "#tour-subs", title: "רשימת התפוצה", body: "כמה נרשמים יש, וכמה מהם הגיעו דרך אתר התוכניות. את הרשימה המלאה מנהלים ב„רשימת תפוצה” בתפריט." },
  ],
  "prog-publish": [
    { target: "#tour-publish", title: "מה מחכה לפרסום", body: "רשימה של כל מה שהשתנה מאז הפרסום האחרון. הכפתור מעלה הכול לאתר. אם יש תוכניות חדשות — אפשר לשלוח עליהן התראה, ולהכין מייל למאזינים. אם מנהל אחר פרסם בינתיים, הפרסום נעצר ושואל, כדי שלא יידרס כלום." },
    { target: "#tour-build", title: "בניית האתר", body: "דפי השיתוף לוואטסאפ ומפת האתר לגוגל נבנים פעם בלילה, ולבד אחרי פרסום של תוכנית חדשה. „בנה את האתר עכשיו” מפעיל את הבנייה מיד, ורואים כאן מתי רצה בפעם האחרונה ואם הצליחה." },
    { target: "#tour-health", title: "בדיקת תקינות", body: "מה חסר בתוכניות: בלי הקלטה, בלי אורך, בלי תמונה, בלי תיאור או בלי תאריך, וכפילויות. ליד רוב הקבוצות יש כפתור שמתקן את כולן — למשל יצירת תמונות או תיאורים — והוא רץ ברקע." },
    { target: "#tour-versions", title: "גרסאות קודמות", body: "כל פרסום נשמר כגרסה. אפשר להשוות בין גרסאות, או להחזיר גרסה ישנה לטיוטה ואז לפרסם אותה." },
    { open: '[data-tour="pub-tools"]', target: '[data-tour="pub-tools"]', title: "כלים מתקדמים", body: "קישור לתצוגה מקדימה של הטיוטה (לשלוח למישהו לפני הפרסום), קובץ גיבוי ושחזור ממנו, והעברת הקלטות מהדרייב לאחסון של האתר." },
  ],
};

export const SECTION_TITLES: Record<string, string> = { "prog-programs": "התוכניות", "prog-guests": "המגישים והאורחים", "prog-ads": "ניקוי הפרסומות", "prog-site": "ההודעות לאתר", "prog-polls": "הסקרים", "prog-listeners": "המאזינים", "prog-publish": "הפרסום" };

/** הסבר על חלק אחד (הכפתור „?”) */
export function sectionTour(tab: string): TourStep[] {
  return (SECTION_TOURS[tab] || []).map((step) => ({ ...step, tab }));
}

/** הסיור המקיף: פתיחה, כל החלקים ברצף, וסיום */
export const FULL_TOUR: TourStep[] = [
  { tab: "prog-programs", title: "הסיור המקיף", body: "נעבור על כל חלק בניהול אתר התוכניות — כל כפתור וכל שדה, על המסך האמיתי. זה לוקח כמה דקות; אפשר לעצור בכל רגע, ובכל חלק הכפתור „?” מסביר רק אותו." },
  SHORT_TOUR[1],
  SHORT_TOUR[2],
  ...Object.keys(SECTION_TOURS).flatMap(sectionTour),
  { target: '[data-tour="section-help"]', title: "סיימתם את הסיור המקיף", body: "הכפתור „?” ליד הכותרת מסביר מחדש את החלק שאתם נמצאים בו. והסיורים תמיד בתפריט — גם כדי להראות למנהל חדש." },
];

const PAD = 8, GAP = 14, MARGIN = 16;
type Box = { top: number; left: number; width: number; height: number };

/** מחכה שהאזור יופיע (אחרי מעבר לשונית הוא נטען רגע אחר כך) — עד שתי שניות וחצי */
function waitFor(selector: string, signal: { cancelled: boolean }): Promise<Element | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (signal.cancelled) return resolve(null);
      const el = document.querySelector(selector);
      const box = el?.getBoundingClientRect();
      if (el && box && box.width > 0 && box.height > 0) return resolve(el);
      if (Date.now() - started > 2500) return resolve(null);
      setTimeout(tick, 80);
    };
    tick();
  });
}

export function AdminTour({ steps, onNavigate, onClose }: { steps: TourStep[]; onNavigate(tab: string): void; onClose(done: boolean): void }) {
  const [index, setIndex] = useState(0);
  // המדידה שייכת לצעד שבו נעשתה — בצעד חדש אין הארה עד שהאזור שלו נמצא
  const [measured, setMeasured] = useState<{ index: number; box: Box | null }>({ index: -1, box: null });
  const [cardSize, setCardSize] = useState({ width: 360, height: 220 });
  const target = useRef<Element | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  const measure = useCallback((at: number) => {
    const el = target.current;
    if (!el || !el.isConnected) { setMeasured({ index: at, box: null }); return; }
    const r = el.getBoundingClientRect();
    setMeasured({ index: at, box: { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 } });
  }, []);
  let box = measured.index === index ? measured.box : null;

  // מעבר צעד: הלשונית, ואז מחכים לאזור, גוללים אליו ומודדים
  useEffect(() => {
    const signal = { cancelled: false };
    target.current = null;
    if (step.tab) onNavigate(step.tab);
    const visible = (selector?: string) => { const r = selector ? document.querySelector(selector)?.getBoundingClientRect() : null; return !!r && r.width > 0 && r.height > 0; };
    const prepare = async () => {
      // לחיצה רק כשהאזור עוד לא על המסך (למשל: אף תוכנית לא פתוחה בעורך)
      if (step.click && !visible(step.target)) {
        await new Promise((resolve) => setTimeout(resolve, 150));   // הלשונית מספיקה להתחלף
        if (!visible(step.target)) (await waitFor(step.click, signal) as HTMLElement | null)?.click();
      }
      if (step.open) { const d = await waitFor(step.open, signal); if (d instanceof HTMLDetailsElement && !d.open) d.open = true; }
    };
    if (step.target) {
      void prepare().then(() => waitFor(step.target!, signal)).then((el) => {
        if (signal.cancelled) return;
        target.current = el;
        if (el) {
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const r = el.getBoundingClientRect();
          // אזור גבוה מהמסך — מתחילתו; אחרת במרכז
          el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? "start" : "center", behavior: reduce ? "auto" : "smooth" });
        }
        measure(index);
      });
    }
    next.current?.focus({ preventScroll: true });
    return () => { signal.cancelled = true; };
  }, [index, step.tab, step.target, step.click, step.open, onNavigate, measure]);

  // עוקבים אחרי גלילה ושינוי גודל, כדי שההארה תישאר על האזור
  useEffect(() => {
    let frame = 0;
    const on = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => measure(index)); };
    window.addEventListener("scroll", on, true); window.addEventListener("resize", on);
    const id = window.setInterval(() => measure(index), 400);   // תוכן שנטען מאוחר מזיז את האזור
    return () => { window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); window.clearInterval(id); cancelAnimationFrame(frame); };
  }, [measure, index]);

  useLayoutEffect(() => {
    const el = card.current; if (!el) return;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width - cardSize.width) > 1 || Math.abs(r.height - cardSize.height) > 1) setCardSize({ width: r.width, height: r.height });
  }, [index, measured, cardSize.width, cardSize.height]);

  const go = useCallback((delta: number) => setIndex((i) => Math.min(steps.length - 1, Math.max(0, i + delta))), [steps.length]);
  const finish = useCallback((done: boolean) => onClose(done), [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      // בעברית "קדימה" הוא שמאלה
      else if (e.key === "ArrowLeft") { e.preventDefault(); if (last) finish(true); else go(1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, finish, last]);

  // מיקום הכרטיס: מתחת לאזור, ואם אין מקום — מעליו; בלי אזור — במרכז המסך
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth, vh = typeof window === "undefined" ? 800 : window.innerHeight;
  let cardStyle: React.CSSProperties;
  if (!box) cardStyle = { top: Math.max(MARGIN, (vh - cardSize.height) / 2), left: Math.max(MARGIN, (vw - cardSize.width) / 2) };
  else {
    // אזור רחב מהמסך (התפריט בטלפון) — ההארה נחתכת לשוליים; אזור גבוה מדי — נשאר רק החלק העליון שלו,
    // כדי שהכרטיס ייכנס מתחתיו ולא יסתיר אותו
    const left0 = Math.max(4, box.left), right0 = Math.min(vw - 4, box.left + box.width);
    box = { ...box, left: left0, width: Math.max(0, right0 - left0) };
    const room = vh - MARGIN - GAP - cardSize.height - Math.max(box.top, MARGIN);
    if (box.top + box.height + GAP + cardSize.height > vh - MARGIN && box.top - GAP - cardSize.height < MARGIN && room >= 60) box = { ...box, height: Math.min(box.height, room) };
    const below = box.top + box.height + GAP, above = box.top - GAP - cardSize.height;
    const top = below + cardSize.height <= vh - MARGIN ? below : above >= MARGIN ? above : Math.max(MARGIN, vh - cardSize.height - MARGIN);
    // מיושר לקצה הימני של האזור (עברית), ולא יוצא מהמסך
    const left = Math.min(Math.max(MARGIN, box.left + box.width - cardSize.width), vw - cardSize.width - MARGIN);
    cardStyle = { top, left };
  }

  return <div className="admin-tour" dir="rtl">
    <div className="admin-tour-block" onClick={(e) => e.stopPropagation()} />
    {box ? <div className="admin-tour-hole" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} aria-hidden="true" /> : <div className="admin-tour-dim" aria-hidden="true" />}
    <div ref={card} className="admin-tour-card" role="dialog" aria-modal="true" aria-labelledby="admin-tour-title" aria-describedby="admin-tour-body" style={cardStyle}>
      <div className="admin-tour-progress" aria-hidden="true">{steps.map((_, i) => <i key={i} className={i === index ? "on" : i < index ? "done" : ""} />)}</div>
      <p className="admin-tour-count">צעד {index + 1} מתוך {steps.length}</p>
      <h2 id="admin-tour-title">{step.title}</h2>
      <p id="admin-tour-body">{step.body}</p>
      <div className="admin-tour-actions">
        <button ref={next} type="button" className="admin-tour-next" onClick={() => (last ? finish(true) : go(1))}>{last ? "סיום" : index === 0 && !step.target ? "יאללה, מתחילים ←" : "הבא ←"}</button>
        {index > 0 && <button type="button" onClick={() => go(-1)}>→ הקודם</button>}
        {!last && <button type="button" className="admin-tour-skip" onClick={() => finish(false)}>{steps.length <= 6 ? "סגירה" : "דילוג על הסיור"}</button>}
      </div>
    </div>
  </div>;
}

/** הבחירה בפתיחת הסיור: קצר (דקה) או מקיף (כל כפתור וכל שדה) */
export function TourChooser({ onPick, onClose }: { onPick(kind: "short" | "full"): void; onClose(): void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const full = FULL_TOUR.length;
  return <div className="admin-tour" dir="rtl">
    <div className="admin-tour-block" />
    <div className="admin-tour-dim" aria-hidden="true" />
    <div className="admin-tour-card admin-tour-chooser" role="dialog" aria-modal="true" aria-labelledby="admin-tour-choose-title">
      <p className="admin-tour-count">סיור בניהול אתר התוכניות</p>
      <h2 id="admin-tour-choose-title">איזה סיור מתאים לכם?</h2>
      <div className="admin-tour-options">
        <button ref={first} type="button" onClick={() => onPick("short")}><b>⚡ סיור קצר</b><span>דקה אחת · {SHORT_TOUR.length} צעדים</span><small>החלקים הראשיים ואיפה כל דבר נמצא</small></button>
        <button type="button" onClick={() => onPick("full")}><b>🧭 סיור מקיף</b><span>כמה דקות · {full} צעדים</span><small>כל כפתור וכל שדה, בכל החלקים — כולל העורך של תוכנית</small></button>
      </div>
      <p className="admin-tour-note">בכל חלק יש גם כפתור „?” ליד הכותרת, שמסביר רק אותו.</p>
      <div className="admin-tour-actions"><button type="button" className="admin-tour-skip" onClick={onClose}>לא עכשיו</button></div>
    </div>
  </div>;
}

/* ---------- פעם ראשונה: נשמר במכשיר (בלי שרת). אחסון חסום — פשוט לא נפתח לבד ---------- */
const SEEN_KEY = "rosh-admin-tour-programs-v1";
export function tourSeen(): boolean { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; } }
export function markTourSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* חסום — לא נורא */ } }
