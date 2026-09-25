"use client";

import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { SHARE_SUBJECT, gmailComposeLink, inviteEmailHtml, inviteText, mailtoLink } from "./share-invite.js";
import "./share-parade.css";

/**
 * שיתוף המצעד: כרטיס הזמנה שמבקש מהמצביעים להביא עוד אנשים. שלוש דרכים —
 * הזמנה מעוצבת במייל, שיתוף מהמכשיר עם תמונת הזמנה מעוצבת, והעתקת הקישור.
 * הקישור הוא הדומיין שממנו נפתח האתר, כך שדומיין מותאם יעבוד בלי שינוי בקוד.
 * שום דבר לא עובר דרך השרת ושיתוף אינו נרשם.
 */
const FALLBACK_URL = "https://rosh-berosh.smwlyqswkwt232.workers.dev/";
export const siteUrl = () => typeof window === "undefined" ? FALLBACK_URL : `${window.location.origin}/`;

const svg = (children: React.ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const MailIcon = () => svg(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></>);
export const ShareIcon = () => svg(<><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></>);
const LinkIcon = () => svg(<><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" /></>);
const CheckIcon = () => svg(<path d="m5 12.5 4.5 4.5L19 7.5" />);

/**
 * מייל מעוצב אי אפשר למלא דרך קישור (mailto: ו־Gmail מקבלים רק טקסט), ולכן
 * ההזמנה מועתקת ללוח כ־HTML ומודבקת בגוף המייל. ההעתקה סינכרונית בתוך הלחיצה
 * (execCommand), כך שאינה תלויה בהרשאות הלוח או בפוקוס אחרי await. אירוע ה־copy
 * מחליף את התוכן ב־HTML ובטקסט; דפדפן בלי clipboardData מעתיק לפחות את הטקסט.
 * ה־textarea לקריאה בלבד, כדי שבטלפון לא תקפוץ מקלדת.
 */
function copyRich(html: string, text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.readOnly = true;
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:12pt;pointer-events:none";
  document.body.appendChild(holder);
  holder.select();
  holder.setSelectionRange(0, text.length);
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/html", html);
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  document.removeEventListener("copy", onCopy);
  holder.remove();
  window.getSelection()?.removeAllRanges();
  previous?.focus({ preventScroll: true });
  return copied;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image, () => null);
}

/** תמונת ההזמנה לשיתוף מהמכשיר, באותו עיצוב כמו כרטיס ההצבעה. */
async function buildInviteFile(url: string): Promise<File> {
  const width = 1080, height = 1350;
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("יצירת תמונת ההזמנה נכשלה.");
  const badge = await loadImage("/badge.jpg");
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#151027"); background.addColorStop(.58, "#312653"); background.addColorStop(1, "#9d7b1e");
  ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,.07)";
  ctx.beginPath(); ctx.arc(110, 170, 280, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(1000, 1270, 240, 0, Math.PI * 2); ctx.fill();
  if (badge) {
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14;
    ctx.drawImage(badge, (width - 300) / 2, 64, 300, 300); ctx.restore();
  }
  ctx.direction = "rtl"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ead47a"; ctx.font = "800 34px Arial"; ctx.fillText("הזמנה אישית למצעד", width / 2, 432);
  ctx.fillStyle = "#fff"; ctx.font = "900 100px Arial"; ctx.fillText("מצעד האלבומים", width / 2, 540);
  ctx.fillStyle = "#f2e8bd"; ctx.font = "800 42px Arial"; ctx.fillText("ראש בראש · 25 שנות מוזיקה יהודית", width / 2, 606);
  ctx.fillStyle = "rgba(255,255,255,.97)"; ctx.beginPath(); ctx.roundRect(80, 664, 920, 396, 40); ctx.fill();
  const rows = [["האלבומים הגדולים", "בוחרים את האהובים עליכם"], ["השירים", "מכל אלבום, השיר שהכי נגע בכם"], ["הזמרים", "הקולות שליוו אתכם לאורך השנים"]];
  rows.forEach(([title, text], index) => {
    const y = 766 + index * 112;
    ctx.fillStyle = "#b89530"; ctx.beginPath(); ctx.arc(916, y - 12, 34, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "900 34px Arial"; ctx.fillText(String(index + 1), 916, y);
    ctx.textAlign = "right"; ctx.fillStyle = "#2b2340"; ctx.font = "900 38px Arial"; ctx.fillText(title, 856, y - 8);
    ctx.fillStyle = "#746a7d"; ctx.font = "700 27px Arial"; ctx.fillText(text, 856, y + 30);
  });
  const cta = ctx.createLinearGradient(160, 0, 920, 0); cta.addColorStop(0, "#f0d66e"); cta.addColorStop(1, "#b89530");
  ctx.fillStyle = cta; ctx.beginPath(); ctx.roundRect(160, 1106, 760, 104, 52); ctx.fill();
  ctx.textAlign = "center"; ctx.fillStyle = "#1b1433"; ctx.font = "900 44px Arial"; ctx.fillText("הקול שלכם קובע — הצביעו עכשיו", width / 2, 1174);
  ctx.fillStyle = "#f4eac4"; ctx.font = "700 30px Arial"; ctx.fillText(new URL(url).host, width / 2, 1288);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("יצירת תמונת ההזמנה נכשלה.")), "image/png"));
  return new File([blob], "הזמנה-למצעד-ראש-בראש.png", { type: "image/png" });
}

// התמונה זהה לכולם, ולכן נבנית פעם אחת לכל טעינת עמוד — ומראש, כי חלון השיתוף
// בטלפון חייב להיפתח מיד בלחיצה, בלי לחכות לציור.
let invitePromise: Promise<File> | null = null;
function inviteFile(url: string) {
  invitePromise ??= buildInviteFile(url).catch((error) => { invitePromise = null; throw error; });
  return invitePromise;
}

const fitPreview = (event: SyntheticEvent<HTMLIFrameElement>) => {
  const height = event.currentTarget.contentDocument?.documentElement.scrollHeight;
  if (height) event.currentTarget.style.height = `${height}px`;
};

type CardProps = { kicker?: string; heading?: string; blurb?: string; inDialog?: boolean };
type RichState = "idle" | "copying" | "copied";

export function ShareParadeCard({ kicker = "עזרו למצעד לגדול", heading = "הביאו את החברים למצעד!", blurb = "כל קול מזיז את הדירוג. שלחו לחברים ולמשפחה הזמנה במייל, ותנו גם להם לבחור את האלבומים, השירים והזמרים של 25 שנות מוזיקה יהודית.", inDialog = false }: CardProps) {
  const headingId = useId();
  const [url] = useState(siteUrl);
  const [touch] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches);
  const [canShare] = useState(() => typeof navigator !== "undefined" && typeof navigator.share === "function");
  const [rich, setRich] = useState<RichState>("idle");
  // המשוב מוצג בתוך הכרטיס ולא בהודעה הצפה: בחלון הקופץ ההודעה הצפה נשארת מאחורי הרקע הכהה.
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const imageFile = useRef<File | null>(null);
  const html = inviteEmailHtml(url);
  const text = inviteText(url);
  // הדרך הראשית: מייל חדש שההזמנה כבר כתובה בו — בלי להעתיק ובלי הרשאות.
  // במחשב Gmail בדפדפן (כל המצביעים מחוברים עם Google), בטלפון אפליקציית המייל.
  const mailBody = inviteText(url, { headline: false });
  const composeHref = touch ? mailtoLink({ body: mailBody }) : gmailComposeLink({ body: mailBody });

  useEffect(() => {
    if (!canShare) return;
    let active = true;
    inviteFile(url).then((file) => { if (active) imageFile.current = file; }, () => undefined);
    return () => { active = false; };
  }, [canShare, url]);

  const richFailed = () => {
    setRich("idle");
    setStatus({ text: "לא הצלחנו להעתיק את הגרסה המעוצבת בדפדפן הזה. הכפתור „שליחת הזמנה במייל” פותח מייל שההזמנה כבר כתובה בו.", tone: "error" });
  };
  // הגרסה המעוצבת: מייל עם HTML אי אפשר למלא בקישור, ולכן היא מועתקת ומודבקת.
  const startRich = () => {
    setStatus(null);
    if (copyRich(html, text)) { setRich("copied"); return; }
    if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
      setRich("copying");
      navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
        .then(() => setRich("copied"), richFailed);
      return;
    }
    richFailed();
  };
  const copyLink = async () => {
    setStatus(null);
    try {
      await navigator.clipboard.writeText(url);
      setStatus({ text: "הקישור הועתק — הדביקו אותו בהודעה לחברים.", tone: "ok" });
    } catch {
      // בלי גישה ללוח (דפדפן ישן או חיבור לא מאובטח) הקישור מוצג לסימון ידני.
      setRevealed(true);
      setStatus({ text: "לא הצלחנו להעתיק אוטומטית. סמנו את הקישור והעתיקו אותו ידנית.", tone: "error" });
    }
  };
  const share = async () => {
    setStatus(null);
    const plain: ShareData = { title: SHARE_SUBJECT, text };
    const withImage: ShareData | null = imageFile.current ? { ...plain, files: [imageFile.current] } : null;
    try {
      await navigator.share(withImage && navigator.canShare?.(withImage) ? withImage : plain);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus({ text: "חלון השיתוף לא נפתח. אפשר לשלוח את ההזמנה במייל או להעתיק את הקישור.", tone: "error" });
    }
  };

  // אחרי העתקת הגרסה המעוצבת המייל נפתח ריק ומחכה להדבקה.
  const pasteHref = touch ? mailtoLink() : gmailComposeLink();
  const previewDoc = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{margin:0}</style></head><body>${html}</body></html>`;

  return <section className={`share-invite${inDialog ? " in-dialog" : ""}`} aria-labelledby={headingId}>
    <header className="share-invite-hero">
      <span className="share-invite-sparkles" aria-hidden="true"><i>✦</i><i>✦</i><i>✦</i><i>✦</i></span>
      <img className="share-invite-badge" src="/badge-small.png" alt="" />
      <p className="share-invite-kicker">✦ {kicker} ✦</p>
      <h2 id={headingId}>{heading}</h2>
      <p className="share-invite-blurb">{blurb}</p>
    </header>
    <div className="share-invite-body">
      <a className="share-invite-mail" href={composeHref} target={touch ? undefined : "_blank"} rel="noopener noreferrer" onClick={() => setStatus({ text: "נפתח מייל חדש שההזמנה כבר כתובה בו — מוסיפים את כתובות החברים ושולחים.", tone: "ok" })}><MailIcon />שליחת הזמנה במייל</a>
      {!touch && <a className="share-invite-alt" href={mailtoLink({ body: mailBody })}>לא בג׳ימייל? פתיחה בתוכנת הדואר שבמחשב</a>}
      <div className={`share-invite-more${canShare ? "" : " single"}`}>
        {canShare && <button type="button" onClick={() => void share()}><ShareIcon />שיתוף ההזמנה</button>}
        <button type="button" onClick={() => void copyLink()}><LinkIcon />העתקת הקישור</button>
      </div>
      {revealed && <input className="share-invite-link" readOnly value={url} dir="ltr" aria-label="הקישור לאתר המצעד" onFocus={(event) => event.currentTarget.select()} />}
      {status && <p className={`share-invite-status ${status.tone}`} role="status">{status.text}</p>}
      {rich === "copied" ? <div className="share-mail">
        <p className="share-mail-title" role="status"><CheckIcon />ההזמנה המעוצבת הועתקה</p>
        <ol className="share-mail-steps">
          <li><b>1</b><span>פותחים מייל חדש בכפתור שכאן למטה</span></li>
          <li><b>2</b><span>{touch ? "לוחצים לחיצה ארוכה בגוף ההודעה ובוחרים „הדבקה”" : <>לוחצים בגוף ההודעה ומדביקים: <kbd dir="ltr">Ctrl+V</kbd> (במק: <kbd dir="ltr">⌘+V</kbd>)</>}</span></li>
          <li><b>3</b><span>מוסיפים את כתובות החברים ושולחים</span></li>
        </ol>
        <a className="share-mail-open" href={pasteHref} target={touch ? undefined : "_blank"} rel="noopener noreferrer"><MailIcon />{touch ? "פתיחת אפליקציית המייל" : "פתיחת מייל חדש ב־Gmail"}</a>
        {!touch && <a className="share-mail-alt" href={mailtoLink()}>או בתוכנת הדואר שבמחשב</a>}
        <details className="share-mail-preview" open={!inDialog}>
          <summary>כך תיראה ההזמנה</summary>
          <iframe title="תצוגה מקדימה של ההזמנה" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={previewDoc} onLoad={fitPreview} />
        </details>
      </div> : <>
        <button type="button" className="share-invite-designed" disabled={rich === "copying"} onClick={startRich}>{rich === "copying" ? "מכינים את הגרסה המעוצבת…" : "✨ רוצים גרסה מעוצבת? העתקה והדבקה"}</button>
        <p className="share-invite-note">💌 ההזמנה יוצאת מהמייל שלכם, רק לאנשים שתבחרו.</p>
      </>}
    </div>
  </section>;
}

/** מה הביא את החלון: כניסה חוזרת של מי שכבר הצביע, אמצע ההצבעה, או כפתור השיתוף בכותרת. */
export type SharePromptReason = "voted" | "mid" | "manual";

const PROMPTS: Record<SharePromptReason, { kicker: string; heading: string; blurb: string; close: string; primary?: boolean }> = {
  voted: { kicker: "הקול שלכם כבר בפנים", heading: "עכשיו תורם של החברים", blurb: "הזמינו חברים ובני משפחה להצביע — כל קול נוסף מקרב את האהובים עליכם לפסגה.", close: "לא עכשיו" },
  mid: { kicker: "רגע לפני שממשיכים", heading: "המצעד שווה יותר עם חברים", blurb: "שלחו הזמנה לחברים ולמשפחה. הבחירות שלכם שמורות, ואפשר להמשיך מיד.", close: "המשך להצבעה", primary: true },
  manual: { kicker: "ראש בראש", heading: "הזמינו חברים למצעד", blurb: "שלחו הזמנה לחברים ולמשפחה, כדי שגם הם יבחרו את האלבומים, השירים והזמרים האהובים עליהם.", close: "סגירה" },
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
  return <div className="share-overlay" role="dialog" aria-modal="true" aria-label={prompt.heading} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="share-dialog">
      <button ref={closeRef} className="share-close" type="button" aria-label="סגירת החלון" onClick={onClose}>×</button>
      <ShareParadeCard kicker={prompt.kicker} heading={prompt.heading} blurb={prompt.blurb} inDialog />
      <div className="share-dialog-foot"><button className={prompt.primary ? "continue share-continue" : "share-later"} type="button" onClick={onClose}>{prompt.close}{prompt.primary && <span>←</span>}</button></div>
    </section>
  </div>;
}
