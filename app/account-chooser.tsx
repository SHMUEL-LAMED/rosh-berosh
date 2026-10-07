"use client";

import { useEffect, useId, useRef, type ReactNode, type Ref } from "react";
import "./account-chooser.css";

/**
 * חלון בחירת חשבון — החלון של Google ("כניסה אל האתר באמצעות google.com", "בחירת חשבון להמשך")
 * בתוך האתר, למי שכבר נכנס מהמכשיר הזה. רק תצוגה: מסך הכניסה (app/auth-ui.tsx) מחזיק את המצב,
 * מדבר עם ספריית Google ומצייר את כפתור Google לתוך slotRef כשבוחרים חשבון או "שימוש בחשבון אחר".
 */
export type KnownAccount = { email: string; name: string; picture: string; at: number };
export type ChooserMode = "list" | "picked" | "other";

type Props = {
  host: string;
  accounts: KnownAccount[];
  mode: ChooserMode;
  picked: KnownAccount | null;
  slotRef: Ref<HTMLDivElement>;
  error?: string;
  onPick(account: KnownAccount): void;
  onOther(): void;
  onBack(): void;
  onCancel(): void;
};

const GooglePaths = () => <>
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
</>;

// האיור שבראש החלון: תג עגול עם הלוגו של Google, ונקודות משני צדדיו
const Art = () => <svg viewBox="0 0 320 104" aria-hidden="true" focusable="false">
  <g fill="none" stroke="#c4c7c5" strokeWidth="3" strokeLinecap="round" strokeDasharray="0.1 7">
    <path d="M18 36h40" /><path d="M34 54h60" /><path d="M58 74h30" /><path d="M262 36h40" /><path d="M226 54h60" /><path d="M232 74h30" />
  </g>
  <g fill="#c4c7c5"><circle cx="100" cy="24" r="3" /><circle cx="76" cy="92" r="2.5" /><circle cx="220" cy="24" r="3" /><circle cx="244" cy="92" r="2.5" /><circle cx="112" cy="82" r="2" /><circle cx="208" cy="82" r="2" /></g>
  <circle cx="160" cy="52" r="44" fill="#fff" stroke="#e3e3e3" strokeWidth="7" strokeDasharray="7 5" />
  <circle cx="160" cy="52" r="40" fill="#fff" />
  <g transform="translate(140 32) scale(.8333)"><GooglePaths /></g>
</svg>;

const Go = () => <svg className="chooser-go" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.5 5 7.5 12l8 7z" /></svg>;

const AVATAR_COLORS = ["#7b1fa2", "#1e88e5", "#43a047", "#e53935", "#fb8c00", "#00897b"];
function Avatar({ account }: { account: KnownAccount }) {
  if (account.picture) return <img className="chooser-avatar" src={account.picture} alt="" referrerPolicy="no-referrer" />;
  const letter = (account.name || account.email).trim().slice(0, 1).toUpperCase() || "?";
  const color = AVATAR_COLORS[[...account.email].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  return <span className="chooser-avatar" style={{ background: color }} aria-hidden="true">{letter}</span>;
}

export function AccountChooser({ host, accounts, mode, picked, slotRef, error, onPick, onOther, onBack, onCancel }: Props) {
  const titleId = useId();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode === "list") first.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, onCancel]);

  let subtitle = "בחירת חשבון להמשך";
  let status: ReactNode = "לחצו על הכפתור ובחרו חשבון ב־Google.";
  if (mode === "picked" && picked) { subtitle = "ממשיכים עם החשבון שבחרתם"; status = <><b>ממשיכים עם {picked.name || picked.email}</b><small dir="ltr">{picked.email}</small></>; }
  else if (mode === "other") subtitle = "בחירת חשבון Google אחר";

  return <div className="chooser-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="chooser-window">
      <div className="chooser-art"><Art /></div>
      <h2 id={titleId}>כניסה אל <span dir="ltr">{host}</span> באמצעות google.com</h2>
      <p className="chooser-sub">{subtitle}</p>
      {mode === "list"
        ? <ul className="chooser-list">{accounts.map((account, index) => <li key={account.email}>
          <button type="button" className="chooser-account" ref={index === 0 ? first : undefined} onClick={() => onPick(account)}>
            <Avatar account={account} />
            <span className="chooser-who"><b>{account.name || account.email.split("@")[0]}</b><small dir="ltr">{account.email}</small></span>
            <Go />
          </button>
        </li>)}</ul>
        : <div className="chooser-picked">
          <p className="chooser-status" role="status">{status}</p>
          <div ref={slotRef} className="chooser-google" />
          <p className={`chooser-hint${error ? " bad" : ""}`}>{error || (mode === "picked" ? "אם לא נפתח חלון של Google, לחצו על הכפתור." : "")}</p>
        </div>}
      <div className="chooser-foot">
        <button type="button" className="chooser-btn" onClick={mode === "list" ? onOther : onBack}>{mode === "list" ? "שימוש בחשבון אחר" : "חזרה לבחירת חשבון"}</button>
        <button type="button" className="chooser-btn" onClick={onCancel}>ביטול</button>
      </div>
    </section>
  </div>;
}
