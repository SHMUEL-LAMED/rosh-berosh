"use client";

import { useEffect, useMemo, useState } from "react";
import { downloadSubscribersXlsx } from "./xlsx-export";
import { xlsxToText } from "./xlsx-import";
import "./subscribers-panel.css";

type Subscriber = { id: string; email: string; name?: string | null; source?: string | null; consentedAt?: number | null; unsubscribedAt?: number | null; handledAt?: number | null; createdAt: number };
/** „חדשים” — עוד לא הועברו לרשימה האחרת; „טופלו” — כבר הועברו; „הכול” — כל הרשימה */
type View = "new" | "handled" | "all";
const VIEWS: Array<[View, string]> = [["new", "חדשים"], ["handled", "טופלו"], ["all", "הכול"]];
const day = (seconds: number) => new Date(seconds < 1_000_000_000_000 ? seconds * 1000 : seconds).toLocaleDateString("he-IL");
type ImportResult = { found: number; added: number; duplicates: number; optedOut?: number; skipped: number };
const EMAILS = /[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]{2,}/g;

/** רשימת הנמענים, הורדה לאקסל, והוספת כתובות (הדבקה או קובץ אקסל / CSV). הרשימה משמשת גם את טיוטת
    המייל שאתר התוכניות יוצר בג׳ימייל על כל תוכנית חדשה. מי שהסיר את עצמו בעבר לא חוזר בייבוא.
    „חדשים” ו„טופלו”: מעתיקים את החדשים לרשימה האחרת ומסמנים אותם כטופלו — וכך תמיד יודעים מי הצטרף מאז. */
export function SubscribersPanel({ onMessage }: { onMessage(text: string): void }) {
  const [rows, setRows] = useState<Subscriber[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<View>("new"), [marking, setMarking] = useState(false), [loadedAt, setLoadedAt] = useState(0);
  const fresh = useMemo(() => rows.filter((row) => !row.handledAt), [rows]);
  const shown = view === "new" ? fresh : view === "handled" ? rows.filter((row) => row.handledAt) : rows;
  const [text, setText] = useState(""), [fileName, setFileName] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState<ImportResult | null>(null);
  const found = useMemo(() => new Set((text.match(EMAILS) || []).map((email) => email.toLowerCase())).size, [text]);

  // הטעינה יושבת בתוך האפקט ואינה קוראת ל-setState באופן סינכרוני בכניסה אליו,
  // כי `loading` כבר מתחיל כ-true ואין צורך להצית רינדור נוסף.
  useEffect(() => {
    let active = true;
    fetch("/api/admin/subscribers", { cache: "no-store" })
      .then((response) => response.json().then((data) => { if (!response.ok) throw new Error(data.error); return data; }))
      .then((data) => { if (!active) return; setRows(data.subscribers ?? []); setActive(data.active ?? 0); setLoadedAt(Math.floor(Date.now() / 1000)); })
      .catch(() => { if (active) onMessage("טעינת רשימת התפוצה נכשלה."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onMessage, reload]);

  /** קובץ שנבחר נכנס לתיבה (אחרי מה שכבר כתוב בה), כדי שאפשר יהיה לבדוק לפני ההוספה */
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = /\.xlsx$/i.test(file.name) ? xlsxToText(new Uint8Array(await file.arrayBuffer())) : await file.text();
      setText((current) => [current.trim(), content.trim()].filter(Boolean).join("\n"));
      setFileName(file.name); setResult(null);
    } catch (error) { onMessage(error instanceof Error ? error.message : "קריאת הקובץ נכשלה."); }
  };
  const add = async () => {
    setBusy(true); setResult(null);
    try {
      const response = await fetch("/api/admin/subscribers/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }) });
      const data = await response.json().catch(() => ({})) as ImportResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "ההוספה נכשלה.");
      setResult(data); setText(""); setFileName(""); setLoading(true); setReload((value) => value + 1);
      onMessage(data.added ? `נוספו ${data.added.toLocaleString("he-IL")} כתובות לרשימת התפוצה.` : "לא נוספו כתובות חדשות — כולן כבר ברשימה.");
    } catch (error) { onMessage(error instanceof Error ? error.message : "ההוספה נכשלה."); }
    finally { setBusy(false); }
  };

  /** סימון כטופלו (או החזרה ל„חדשים”): כל החדשים שבמסך, או כתובת אחת */
  const mark = async (body: { all: true; before: number } | { emails: string[]; handled: boolean }, done: string) => {
    setMarking(true);
    try {
      const response = await fetch("/api/admin/subscribers/handled", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})) as { changed?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "הסימון נכשל.");
      const now = Math.floor(Date.now() / 1000);
      setRows((list) => list.map((row) => {
        if ("all" in body) return !row.handledAt && row.createdAt <= body.before ? { ...row, handledAt: now } : row;
        return body.emails.includes(row.email) ? { ...row, handledAt: body.handled ? now : null } : row;
      }));
      onMessage(done.replace("{n}", (data.changed ?? 0).toLocaleString("he-IL")));
    } catch (error) { onMessage(error instanceof Error ? error.message : "הסימון נכשל."); }
    finally { setMarking(false); }
  };
  const markAll = () => {
    if (!fresh.length || !confirm(`לסמן את כל ${fresh.length.toLocaleString("he-IL")} החדשים כטופלו? מי שיצטרף מעכשיו יופיע שוב ב„חדשים”.`)) return;
    void mark({ all: true, before: loadedAt || Math.floor(Date.now() / 1000) }, "{n} נמענים סומנו כטופלו.");
  };
  const copyShown = async () => {
    const text = shown.map((row) => row.email).join("\n");
    try { await navigator.clipboard.writeText(text); onMessage(`${shown.length.toLocaleString("he-IL")} כתובות הועתקו — אחת בכל שורה.`); }
    catch { onMessage("ההעתקה לא הצליחה. נסו את ההורדה לאקסל."); }
  };
  const viewName = VIEWS.find(([key]) => key === view)?.[1] || "";

  return <AdminSection title="רשימת התפוצה">
    <p className="panel-help">כל מי שביקש לקבל עדכונים מהאתר. ההרשמה בקו הטלפון מנוהלת בנפרד ואינה מגיעה לכאן.</p>
    <div className="subscriber-toolbar">
      <div className="subscriber-count"><b>{active.toLocaleString("he-IL")}</b> נמענים{!loading && <> · <b className="subscriber-new-count">{fresh.length.toLocaleString("he-IL")}</b> חדשים</>}</div>
    </div>
    <div className="subscriber-handled-help">
      <b>חדשים וטופלו</b> — העתיקו או הורידו את <b>החדשים</b>, הוסיפו אותם לרשימה האחרת, ולחצו „סימון כל החדשים כטופלו”. מי שיצטרף אחר כך יופיע שוב ב„חדשים”.
    </div>
    <div className="subscriber-tabs" role="tablist" aria-label="איזה נמענים להציג">
      {VIEWS.map(([key, title]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "on" : ""} onClick={() => setView(key)}>
        {title} <span>{(key === "new" ? fresh.length : key === "handled" ? rows.length - fresh.length : rows.length).toLocaleString("he-IL")}</span>
      </button>)}
    </div>
    <div className="subscriber-toolbar">
      <button type="button" disabled={loading || !shown.length} onClick={() => void copyShown()}>העתקת הכתובות ({viewName})</button>
      <button type="button" disabled={loading || !shown.length} onClick={() => downloadSubscribersXlsx(shown, `rosh-berosh-subscribers-${view === "new" ? "new-" : view === "handled" ? "handled-" : ""}${new Date().toISOString().slice(0, 10)}.xlsx`)}>הורדה לאקסל ({viewName})</button>
      <button type="button" className="subscriber-primary" disabled={loading || marking || !fresh.length} onClick={markAll}>{marking ? "מסמנים…" : `✓ סימון כל החדשים כטופלו${fresh.length ? ` (${fresh.length.toLocaleString("he-IL")})` : ""}`}</button>
    </div>
    <div className="subscriber-add">
      <h3>הוספת כתובות לרשימה</h3>
      <p className="panel-help">מדביקים כתובות — אחת בכל שורה, שורות מאקסל, או &quot;שם &lt;כתובת&gt;&quot; מג׳ימייל — או מעלים קובץ אקסל, CSV או טקסט. כתובת שכבר ברשימה לא תוכפל, ומי שהסיר את עצמו בעבר לא יחזור לרשימה. הוסיפו רק אנשים שביקשו לקבל את המיילים.</p>
      <textarea dir="ltr" rows={6} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder={"name@example.com\nשרה כהן <sara@example.com>"} aria-label="כתובות להוספה לרשימת התפוצה" spellCheck={false} />
      <div className="subscriber-toolbar">
        <label className="subscriber-file">העלאת קובץ (אקסל / CSV)<input type="file" accept=".xlsx,.csv,.txt,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <span className="subscriber-count">{found ? `${found.toLocaleString("he-IL")} כתובות בתיבה` : ""}{fileName ? ` · ${fileName}` : ""}</span>
        <button type="button" className="subscriber-primary" disabled={busy || !found} onClick={add}>{busy ? "מוסיפים…" : "הוספה לרשימה ←"}</button>
      </div>
      {result && <p className="subscriber-result">✓ נוספו {result.added.toLocaleString("he-IL")} · {result.duplicates.toLocaleString("he-IL")} כבר היו ברשימה{result.optedOut ? ` · ${result.optedOut.toLocaleString("he-IL")} הסירו את עצמם בעבר ולא נוספו` : ""}{result.skipped ? ` · ${result.skipped.toLocaleString("he-IL")} שורות בלי כתובת` : ""}</p>}
    </div>
    {loading ? <p className="loading">טוען…</p> : !rows.length ? <p className="panel-help">אין עדיין נמענים ברשימה.</p> : !shown.length ? <p className="panel-help">{view === "new" ? "אין נמענים חדשים — כולם כבר טופלו. מי שיצטרף מעכשיו יופיע כאן." : "עדיין לא סומן אף נמען כטופל."}</p> : <div className="subscriber-table-wrap"><table className="subscriber-table">
      <thead><tr><th>כתובת דוא״ל</th><th>שם</th><th>נרשם</th><th>מצב</th></tr></thead>
      <tbody>{shown.map((row) => <tr key={row.id} className={row.handledAt ? "handled" : "fresh"}>
        <td dir="ltr" className="subscriber-email">{row.email}</td>
        <td>{row.name || "—"}</td>
        <td>{day(row.createdAt)}</td>
        <td><button type="button" className={`subscriber-state${row.handledAt ? " handled" : ""}`} disabled={marking} title={row.handledAt ? "להחזיר ל„חדשים”" : "לסמן כטופל"} onClick={() => void mark({ emails: [row.email], handled: !row.handledAt }, row.handledAt ? "הנמען חזר ל„חדשים”." : "הנמען סומן כטופל.")}>
          {row.handledAt ? `✓ טופל · ${day(row.handledAt)}` : "● חדש"}
        </button></td>
      </tr>)}</tbody>
    </table></div>}
  </AdminSection>;
}

function AdminSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="admin-panel"><h2>{title}</h2>{children}</section>; }
