"use client";

import { useEffect, useRef, useState } from "react";
import "./share-parade.css";

/**
 * שיתוף המצעד: הזמנה להביא עוד מצביעים, עם קישורים מוכנים לוואטסאפ, לטלגרם
 * ולמייל, העתקת הקישור ללוח, וחלון השיתוף של המכשיר כשהדפדפן תומך בו.
 * הקישור המשותף הוא הדומיין שממנו נפתח האתר, כך שדומיין מותאם יעבוד בלי
 * שינוי בקוד. שום דבר לא עובר דרך השרת ושיתוף אינו נרשם.
 */
const FALLBACK_URL = "https://rosh-berosh.smwlyqswkwt232.workers.dev/";
export const siteUrl = () => typeof window === "undefined" ? FALLBACK_URL : `${window.location.origin}/`;
export const SHARE_TITLE = "ראש בראש – מצעד האלבומים";
export const SHARE_TEXT = "🎶 מצעד האלבומים של ראש בראש – 25 שנות מוזיקה יהודית.\nבואו לבחור גם אתם את האלבומים, השירים והזמרים האהובים עליכם:";

/** קישורי השיתוף: וואטסאפ, טלגרם ומייל נפתחים כשההודעה והקישור כבר בפנים. */
export function shareLinks(url = siteUrl()) {
  const message = `${SHARE_TEXT}\n${url}`;
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(SHARE_TEXT)}`,
    email: `mailto:?subject=${encodeURIComponent(SHARE_TITLE)}&body=${encodeURIComponent(message.replace(/\n/g, "\r\n"))}`,
  };
}

type CardProps = { heading?: string; blurb?: string; compact?: boolean };

export function ShareParadeCard({ heading = "שתפו את המצעד עם עוד אנשים", blurb = "כל קול נוסף משנה את הדירוג. שלחו את הקישור לחברים ולמשפחה, כדי שגם הם יבחרו את האלבומים, השירים והזמרים האהובים עליהם.", compact = false }: CardProps) {
  // המשוב מוצג בתוך הכרטיס ולא בהודעה הצפה: בחלון הקופץ ההודעה הצפה נשארת מאחורי הרקע הכהה.
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [canShare] = useState(() => typeof navigator !== "undefined" && typeof navigator.share === "function");
  const url = siteUrl();
  const links = shareLinks(url);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus({ text: "הקישור הועתק. הדביקו אותו בהודעה לחברים.", tone: "ok" });
    } catch {
      // בלי גישה ללוח (דפדפן ישן או חיבור לא מאובטח) הקישור מוצג לסימון ידני.
      setRevealed(true);
      setStatus({ text: "לא הצלחנו להעתיק אוטומטית. סמנו את הקישור והעתיקו אותו ידנית.", tone: "error" });
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus({ text: "חלון השיתוף לא נפתח. אפשר להשתמש באחת האפשרויות האחרות.", tone: "error" });
    }
  };

  return <section className={`share-parade${compact ? " compact" : ""}`} aria-label="שיתוף המצעד">
    {!compact && <div className="share-parade-copy"><b>{heading}</b><small>{blurb}</small></div>}
    <div className="share-parade-actions">
      <a className="share-whatsapp" href={links.whatsapp} target="_blank" rel="noopener noreferrer">וואטסאפ</a>
      <a className="share-telegram" href={links.telegram} target="_blank" rel="noopener noreferrer">טלגרם</a>
      <a href={links.email}>מייל</a>
      <button type="button" onClick={() => void copy()}>העתקת הקישור</button>
      {canShare && <button type="button" onClick={() => void share()}>עוד אפשרויות…</button>}
    </div>
    {revealed && <input className="share-parade-link" readOnly value={url} dir="ltr" aria-label="הקישור לאתר המצעד" onFocus={(event) => event.currentTarget.select()} />}
    {status && <p className={`share-parade-status ${status.tone}`} role="status">{status.text}</p>}
  </section>;
}

/** מה הביא את החלון: כניסה חוזרת של מי שכבר הצביע, אמצע ההצבעה, או כפתור השיתוף בכותרת. */
export type SharePromptReason = "voted" | "mid" | "manual";

const PROMPTS: Record<SharePromptReason, { kicker: string; title: string; text: string; close: string; primary?: boolean }> = {
  voted: { kicker: "כבר הצבעתם", title: "עכשיו תורם של החברים", text: "ההצבעה שלכם שמורה. שתפו את המצעד עם עוד אנשים, כדי שגם הקול שלהם ייספר בדירוג.", close: "לא עכשיו" },
  mid: { kicker: "רגע לפני שממשיכים", title: "שתפו את המצעד", text: "כל קול נוסף משנה את הדירוג. שלחו את הקישור לחברים ולמשפחה — הבחירות שלכם נשמרות, ואפשר להמשיך מיד.", close: "המשך להצבעה", primary: true },
  manual: { kicker: "ראש בראש", title: "שתפו את המצעד", text: "הזמינו חברים ומשפחה לבחור את האלבומים, השירים והזמרים האהובים עליהם.", close: "סגירה" },
};

export function ShareParadeDialog({ reason, onClose }: { reason: SharePromptReason; onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // המיקוד עובר לחלון פעם אחת בפתיחה; רינדור חוזר (למשל אחרי העתקה) אינו גונב אותו מהכפתורים.
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const prompt = PROMPTS[reason];
  return <div className="share-overlay" role="dialog" aria-modal="true" aria-labelledby="share-parade-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="share-dialog">
      <button ref={closeRef} className="share-close" type="button" aria-label="סגירת החלון" onClick={onClose}>×</button>
      <p className="kicker">{prompt.kicker}</p>
      <h2 id="share-parade-title">{prompt.title}</h2>
      <p>{prompt.text}</p>
      <ShareParadeCard compact />
      <button className={prompt.primary ? "continue share-continue" : "share-later"} type="button" onClick={onClose}>{prompt.close}{prompt.primary && <span>←</span>}</button>
    </section>
  </div>;
}
