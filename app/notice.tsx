"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type NoticeTone = "info" | "success" | "error" | "progress";
type Notice = { id: number; text: string; tone: NoticeTone };
type NoticeContextType = { notify(text: string, tone?: NoticeTone): void; clear(): void };

const DURATION: Record<NoticeTone, number> = { info: 5000, success: 4000, error: 8000, progress: 0 };
const ERROR_HINTS = ["נכשל", "שגיאה", "לא הצלח", "לא ניתן", "אינו", "אין ", "יש ל", "שגוי", "תקלה"];
const SUCCESS_HINTS = ["בהצלחה", "נשמר", "עודכן", "עודכנה", "נמחק", "הוסר", "נוספ", "אושר", "בוטל", "הועלה", "פורסם"];

// Most call sites hand us a ready Hebrew sentence and no tone, so infer one:
// a trailing ellipsis means work in progress, and the usual failure/confirmation
// wording decides between error and success.
export function toneOf(text: string): NoticeTone {
  if (/(…|\.\.\.)\s*$/.test(text)) return "progress";
  if (ERROR_HINTS.some((hint) => text.includes(hint))) return "error";
  if (SUCCESS_HINTS.some((hint) => text.includes(hint))) return "success";
  return "info";
}

const Ctx = createContext<NoticeContextType>({ notify() {}, clear() {} });

export function useNotice() { return useContext(Ctx); }

let sequence = 0;

export function NoticeProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const clear = useCallback(() => { stopTimer(); setNotice(null); }, [stopTimer]);
  const startTimer = useCallback((tone: NoticeTone) => {
    stopTimer();
    if (DURATION[tone]) timer.current = setTimeout(() => setNotice(null), DURATION[tone]);
  }, [stopTimer]);
  // One slot on purpose: progress updates ("מעלים שיר 2 מתוך 9…") replace each
  // other instead of piling up a stack the manager has to read through.
  const notify = useCallback((text: string, tone?: NoticeTone) => {
    const body = (text ?? "").trim();
    if (!body) return clear();
    const resolved = tone ?? toneOf(body);
    startTimer(resolved);
    setNotice({ id: ++sequence, text: body, tone: resolved });
  }, [clear, startTimer]);
  useEffect(() => stopTimer, [stopTimer]);
  useEffect(() => {
    if (!notice) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notice, clear]);

  return <Ctx.Provider value={{ notify, clear }}>
    {children}
    <div className="notice-layer" dir="rtl" role="status" aria-live={notice?.tone === "error" ? "assertive" : "polite"} aria-atomic="true">
      {notice && <div
        key={notice.id}
        className={`notice notice-${notice.tone}`}
        onMouseEnter={stopTimer}
        onMouseLeave={() => startTimer(notice.tone)}
      >
        {notice.tone === "progress" ? <span className="notice-spinner" aria-hidden="true" /> : <span className="notice-icon" aria-hidden="true">{notice.tone === "success" ? "✓" : notice.tone === "error" ? "!" : "i"}</span>}
        <p className="notice-text">{notice.text}</p>
        <button type="button" className="notice-close" aria-label="סגירת ההודעה" onClick={clear}>×</button>
      </div>}
    </div>
  </Ctx.Provider>;
}
