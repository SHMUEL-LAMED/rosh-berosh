"use client";

/* סיור הדרכה בניהול אתר התוכניות: עובר על המסך האמיתי צעד אחרי צעד — עובר ללשונית
   הנכונה, מאיר את הכפתור או האזור עצמו (כל השאר מוחשך) ומסביר מה עושים בו.
   נפתח לבד בפעם הראשונה שמנהל נכנס לחלק "אתר התוכניות" (נשמר במכשיר), ותמיד
   אפשר לפתוח אותו מחדש מהכפתור בתפריט הצד. אין בו שום פעולה על הנתונים. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./admin-tour.css";

export type TourStep = { tab?: string; target?: string; title: string; body: string };

/** הסיור של אתר התוכניות. `target` — הבורר של האזור שמאירים; בלי `target` הכרטיס במרכז המסך. */
export const PROGRAMS_TOUR: TourStep[] = [
  { tab: "prog-programs", title: "ברוכים הבאים לניהול אתר התוכניות", body: "סיור קצר של דקה על המסך האמיתי: איפה מוסיפים תוכנית, איך משלימים פרטים, ואיך הכול עולה לאתר. אפשר לדלג בכל רגע ולחזור לסיור מהתפריט." },
  { tab: "prog-programs", target: '[data-tour="nav-programs"]', title: "החלקים של אתר התוכניות", body: "תוכניות, אורחים, הודעות לאתר, מאזינים ופרסום — כל חלק במקום אחד בתפריט. הלשונית הפתוחה נשמרת בכתובת, כך שאפשר לשלוח קישור ישר אליה." },
  { tab: "prog-programs", target: ".prog-status", title: "טיוטה שנשמרת לבד", body: "כל שינוי נשמר אוטומטית בטיוטה משותפת בשרת — אפשר להתחיל במחשב ולהמשיך בטלפון. הפס הזה אומר אם יש שינויים שעוד לא עלו לאתר." },
  { tab: "prog-programs", target: ".prog-list .prog-primary", title: "תוכנית חדשה", body: "לחיצה כאן פותחת תוכנית חדשה עם המספר הבא והעונה האחרונה. אחר כך מעלים את ההקלטה, והאורך נקרא מהקובץ לבד." },
  { tab: "prog-programs", target: '[data-tour="prog-find"]', title: "חיפוש, סינון ובחירה מרובה", body: "מוצאים תוכנית לפי שם, מסננים (מוסתרות, מתוזמנות, בלי הקלטה) — וב„בחירה מרובה” מסתירים, מציגים או משייכים לעונה כמה תוכניות יחד." },
  { tab: "prog-programs", target: ".prog-editor", title: "העורך", body: "לחיצה על תוכנית ברשימה פותחת אותה כאן: שם, תאריך, אורחים, הקלטה ותמונה. הבינה המלאכותית מתמללת וכותבת תיאור, ויש פרסום מתוזמן ותצוגה חיה של הדף." },
  { tab: "prog-guests", target: '[data-tour="guests-scan"]', title: "אורחים", body: "כל אורח מקבל באתר דף משלו. כאן מוסיפים לו תמונה וכמה מילים — והכפתור הזה אוסף מהתמלולים את כל מי שהתארח, כדי להשלים את התוכניות בלחיצה." },
  { tab: "prog-site", target: "#tour-banner", title: "הודעה בראש האתר", body: "„התוכנית הבאה ביום חמישי” או ברכה לחג — פס הודעה בראש כל הדפים, שנעלם לבד בתאריך שבוחרים. מתחת: דף העדכונים, פרטי הקשר והעונות." },
  { tab: "prog-listeners", target: "#tour-messages", title: "המאזינים", body: "מה שמאזינים כתבו לכם ותגובות מדפי התוכניות — בתיבה אחת. למעלה: כמה מאזינים, מה הכי נשמע ועד איפה שומעים; ולמטה שליחת התראה לכל המאזינים." },
  { tab: "prog-publish", target: "#tour-publish", title: "הפרסום", body: "כאן רואים מה השתנה ומעלים הכול לאתר בלחיצה אחת. בדיקת התקינות מסמנת מה חסר (ומתקנת בלחיצה), וכל פרסום נשמר כגרסה שאפשר לחזור אליה." },
  { target: '[data-tour="tour-button"]', title: "זהו!", body: "הסיור תמיד כאן בתפריט, אם תרצו לעבור עליו שוב או להראות למנהל חדש." },
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
    if (step.target) {
      void waitFor(step.target, signal).then((el) => {
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
  }, [index, step.tab, step.target, onNavigate, measure]);

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
        <button ref={next} type="button" className="admin-tour-next" onClick={() => (last ? finish(true) : go(1))}>{last ? "סיום" : index === 0 ? "יאללה, מתחילים ←" : "הבא ←"}</button>
        {index > 0 && <button type="button" onClick={() => go(-1)}>→ הקודם</button>}
        {!last && <button type="button" className="admin-tour-skip" onClick={() => finish(false)}>דילוג על הסיור</button>}
      </div>
    </div>
  </div>;
}

/* ---------- פעם ראשונה: נשמר במכשיר (בלי שרת). אחסון חסום — פשוט לא נפתח לבד ---------- */
const SEEN_KEY = "rosh-admin-tour-programs-v1";
export function tourSeen(): boolean { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; } }
export function markTourSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* חסום — לא נורא */ } }
