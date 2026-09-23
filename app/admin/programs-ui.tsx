"use client";

/* רכיבים קטנים המשותפים לכל חלקי ניהול אתר התוכניות */

import type { ChangeEvent, ReactNode } from "react";
import { n2 } from "./programs-core";

/** מתג הפעלה/כיבוי שנראה כמו מתג */
export const Switch = ({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) => <button type="button" role="switch" aria-checked={on} className={`prog-switch${on ? " on" : ""}`} onClick={onClick}><i aria-hidden="true" /><span>{children}</span></button>;
/** בחירת קובץ בעברית, במקום הכפתור האנגלי של הדפדפן */
export const FilePick = ({ accept, onChange, children, disabled }: { accept: string; onChange(event: ChangeEvent<HTMLInputElement>): void; children: ReactNode; disabled?: boolean }) => <label className={`prog-file${disabled ? " busy" : ""}`}><input type="file" accept={accept} onChange={onChange} disabled={disabled} /><span>{children}</span></label>;
export const Section = ({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) => <section className="admin-panel prog-panel" id={id}><header className="prog-panel-head"><h2>{title}</h2>{aside}</header>{children}</section>;
/** שורת מצב של פעולה שרצה (עם סמן) או שגיאה */
export const Status = ({ text, error }: { text?: string; error?: string }) => <>{text ? <span className="prog-progress" role="status"><i aria-hidden="true" />{text}</span> : null}{error ? <span className="prog-error">{error}</span> : null}</>;

/** עמודות אנכיות (לפי יום, שעה או נקודה בתוכנית) */
export function Bars({ items, ariaLabel, pink }: { items: Array<{ key: string; value: number; label: string; title: string }>; ariaLabel: string; pink?: boolean }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return <div className={`prog-bars${pink ? " pink" : ""}`} role="img" aria-label={ariaLabel}>{items.map((i) => <div key={i.key} title={i.title}><i style={{ height: `${Math.round((i.value / max) * 100)}%` }} /><small>{i.label}</small></div>)}</div>;
}
/** פסים אופקיים עם שם ומספר */
export function HBars({ rows }: { rows: Array<{ label: string; n: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return <div className="prog-hbars">{rows.map((r) => <div key={r.label}><span>{r.label}</span><i style={{ width: `${Math.round((r.n / max) * 100)}%` }} /><b>{n2(r.n)}</b></div>)}</div>;
}
