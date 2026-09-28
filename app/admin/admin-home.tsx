"use client";

/* מסך הכניסה לניהול: "מה מחכה לי" — מה שדורש טיפול בשני האתרים, כל שורה לחיצה ומובילה ישר למקום —
   והחיפוש המהיר (Ctrl+K, או הכפתור בכותרת): מקלידים שם של תוכנית, אלבום, שיר, זמר או חלק בניהול
   ומגיעים ישר אליו, בלי לגלול בתפריטים. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./admin-home.css";
import { searchItems } from "./admin-search";

export type Inbox = {
  messagesUnread: number;
  commentsPending: number;
  draft: { updatedAt: number } | null;
  scheduled: Array<{ id: string; title: string; publishAt: string }>;
  scheduledCount: number;
  episodes: Array<{ id: string; title: string; number: number | null; date: string; visible: boolean }>;
};

/** "מה מחכה לי" והחיפוש משתמשים באותם נתונים; נטענים פעם אחת ומתרעננים לפי בקשה */
export function useInbox(enabled: boolean) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    fetch("/api/admin/inbox", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(String(response.status)); setInbox(await response.json()); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { if (enabled) reload(); }, [enabled, reload]);
  return { inbox, failed, reload };
}

const dayTime = (at: string) => {
  const date = new Date(`${at}:00`);
  return Number.isNaN(date.getTime()) ? at : new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
};
const ago = (seconds: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "לפני שעה" : hours === 2 ? "לפני שעתיים" : `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? "אתמול" : `לפני ${days} ימים`;
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

type Row = { key: string; count: number; title: string; detail?: string; onClick(): void; info?: boolean };

export function InboxBoard({ inbox, failed, votes24h, missingPrompts, onNavigate, onOpenEpisode, onReload }: { inbox: Inbox | null; failed: boolean; votes24h: number; missingPrompts: number; onNavigate(tab: string): void; onOpenEpisode(id: string): void; onReload(): void }) {
  const rows: Row[] = [];
  if (inbox) {
    if (inbox.messagesUnread) rows.push({ key: "messages", count: inbox.messagesUnread, title: plural(inbox.messagesUnread, "הודעה אחת שלא נקראה", "הודעות שלא נקראו"), detail: "ממאזינים, מ„כתבו לנו” באתר התוכניות", onClick: () => onNavigate("prog-listeners") });
    if (inbox.commentsPending) rows.push({ key: "comments", count: inbox.commentsPending, title: plural(inbox.commentsPending, "תגובה אחת מחכה לאישור", "תגובות מחכות לאישור"), detail: "מדפי התוכניות — עד האישור הן לא מוצגות", onClick: () => onNavigate("prog-listeners") });
    if (inbox.draft) rows.push({ key: "draft", count: 1, title: "יש שינויים באתר התוכניות שעוד לא פורסמו", detail: `נשמרו בטיוטה ${ago(inbox.draft.updatedAt)}`, onClick: () => onNavigate("prog-publish") });
    for (const item of inbox.scheduled) rows.push({ key: `scheduled-${item.id}`, count: 0, title: `תעלה לאתר ${dayTime(item.publishAt)}: ${item.title || "תוכנית בלי שם"}`, detail: "פרסום מתוזמן — בודקים שהכול מוכן", onClick: () => onOpenEpisode(item.id), info: true });
    if (inbox.scheduledCount > inbox.scheduled.length) rows.push({ key: "scheduled-more", count: inbox.scheduledCount - inbox.scheduled.length, title: `ועוד ${inbox.scheduledCount - inbox.scheduled.length} מתוזמנות בשבועיים הקרובים`, onClick: () => onNavigate("prog-programs"), info: true });
  }
  if (missingPrompts) rows.push({ key: "prompts", count: missingPrompts, title: plural(missingPrompts, "קריינות אחת בקו עוד לא הוקלטה", "קריינויות בקו עוד לא הוקלטו"), detail: "בלי הקלטה הקו משמיע קול ממוחשב או מדלג", onClick: () => onNavigate("ivr") });
  const todo = rows.filter((row) => !row.info).length;
  return <section className="admin-panel inbox" data-tour="inbox" aria-labelledby="inbox-title">
    <header><h2 id="inbox-title">מה מחכה לך</h2><button type="button" className="inbox-refresh" onClick={onReload} aria-label="רענון">↻</button></header>
    <p className="inbox-votes"><b>{votes24h.toLocaleString("he-IL")}</b> הצבעות ב־24 השעות האחרונות · <button type="button" onClick={() => onNavigate("results")}>לתוצאות</button></p>
    {failed && !inbox ? <p className="panel-help">לא הצלחנו לטעון את מה שמחכה לטיפול. <button type="button" className="inbox-link" onClick={onReload}>ניסיון חוזר</button></p>
      : !inbox ? <p className="panel-help">בודקים מה מחכה…</p>
      : rows.length ? <ul className="inbox-list">{rows.map((row) => <li key={row.key}><button type="button" className={row.info ? "info" : ""} onClick={row.onClick}>{row.count > 0 && !row.info ? <i>{row.count > 99 ? "99+" : row.count}</i> : <i className="dot" aria-hidden="true">◷</i>}<span><b>{row.title}</b>{row.detail && <small>{row.detail}</small>}</span><em aria-hidden="true">←</em></button></li>)}</ul>
      : null}
    {inbox && !todo && <p className="inbox-clear">✓ אין שום דבר שמחכה לטיפול כרגע.</p>}
  </section>;
}

/* ---------- החיפוש המהיר ---------- */

export type SearchItem = { kind: "tab" | "episode" | "album" | "song" | "artist"; id: string; title: string; sub?: string };
const KIND_LABEL: Record<SearchItem["kind"], string> = { tab: "חלק בניהול", episode: "תוכנית", album: "אלבום", song: "שיר", artist: "זמר" };

export function QuickSearch({ items, onPick, onClose }: { items: SearchItem[]; onPick(item: SearchItem): void; onClose(): void }) {
  const [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null), opener = useRef<Element | null>(null);
  const results = useMemo(() => searchItems(items, query), [items, query]);
  useEffect(() => { opener.current = document.activeElement; input.current?.focus(); return () => { (opener.current as HTMLElement | null)?.focus?.(); }; }, []);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const pick = (item: SearchItem | undefined) => { if (item) { onPick(item); onClose(); } };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); pick(results[active]); }
    else if (event.key === "Tab") event.preventDefault();
  };
  return <div className="quick-search-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="quick-search" role="dialog" aria-modal="true" aria-label="חיפוש מהיר בניהול" onKeyDown={onKey}>
      <input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder="חיפוש תוכנית, אלבום, שיר, זמר או חלק בניהול…" role="combobox" aria-expanded="true" aria-controls="quick-search-results" aria-activedescendant={results[active] ? `qs-${active}` : undefined} />
      <ul ref={list} id="quick-search-results" role="listbox">
        {results.map((item, index) => <li key={`${item.kind}-${item.id}`} id={`qs-${index}`} data-index={index} role="option" aria-selected={index === active} className={index === active ? "active" : ""} onMouseMove={() => setActive(index)} onClick={() => pick(item)}>
          <span><b>{item.title || "בלי שם"}</b>{item.sub && <small>{item.sub}</small>}</span><em>{KIND_LABEL[item.kind]}</em>
        </li>)}
        {!results.length && <li className="empty">לא נמצא שום דבר בשם הזה.</li>}
      </ul>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> מעבר</span><span><kbd>Enter</kbd> פתיחה</span><span><kbd>Esc</kbd> סגירה</span></footer>
    </div>
  </div>;
}
