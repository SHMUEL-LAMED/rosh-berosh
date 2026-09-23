"use client";

import { useEffect, useMemo, useState } from "react";
import { downloadSubscribersXlsx } from "./xlsx-export";
import { xlsxToText } from "./xlsx-import";
import "./subscribers-panel.css";

type Subscriber = { id: string; email: string; name?: string | null; source?: string | null; consentedAt?: number | null; unsubscribedAt?: number | null; createdAt: number };
type ImportResult = { found: number; added: number; duplicates: number; optedOut?: number; skipped: number };
const EMAILS = /[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]{2,}/g;

/** רשימת הנמענים, הורדה לאקסל, והוספת כתובות (הדבקה או קובץ אקסל / CSV). הרשימה משמשת גם את טיוטת
    המייל שאתר התוכניות יוצר בג׳ימייל על כל תוכנית חדשה. מי שהסיר את עצמו בעבר לא חוזר בייבוא. */
export function SubscribersPanel({ onMessage }: { onMessage(text: string): void }) {
  const [rows, setRows] = useState<Subscriber[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [text, setText] = useState(""), [fileName, setFileName] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState<ImportResult | null>(null);
  const found = useMemo(() => new Set((text.match(EMAILS) || []).map((email) => email.toLowerCase())).size, [text]);

  // הטעינה יושבת בתוך האפקט ואינה קוראת ל-setState באופן סינכרוני בכניסה אליו,
  // כי `loading` כבר מתחיל כ-true ואין צורך להצית רינדור נוסף.
  useEffect(() => {
    let active = true;
    fetch("/api/admin/subscribers", { cache: "no-store" })
      .then((response) => response.json().then((data) => { if (!response.ok) throw new Error(data.error); return data; }))
      .then((data) => { if (!active) return; setRows(data.subscribers ?? []); setActive(data.active ?? 0); })
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

  return <AdminSection title="רשימת התפוצה">
    <p className="panel-help">כל מי שביקש לקבל עדכונים מהאתר. ההרשמה בקו הטלפון מנוהלת בנפרד ואינה מגיעה לכאן.</p>
    <div className="subscriber-toolbar">
      <div className="subscriber-count"><b>{active.toLocaleString("he-IL")}</b> נמענים</div>
      <button type="button" disabled={loading || !rows.length} onClick={() => downloadSubscribersXlsx(rows, `rosh-berosh-subscribers-${new Date().toISOString().slice(0, 10)}.xlsx`)}>הורדה לאקסל</button>
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
    {loading ? <p className="loading">טוען…</p> : !rows.length ? <p className="panel-help">אין עדיין נמענים ברשימה.</p> : <div className="subscriber-table-wrap"><table className="subscriber-table">
      <thead><tr><th>כתובת דוא״ל</th><th>שם</th><th>נרשם</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td dir="ltr" className="subscriber-email">{row.email}</td>
        <td>{row.name || "—"}</td>
        <td>{new Date(row.createdAt < 1_000_000_000_000 ? row.createdAt * 1000 : row.createdAt).toLocaleDateString("he-IL")}</td>
      </tr>)}</tbody>
    </table></div>}
  </AdminSection>;
}

function AdminSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="admin-panel"><h2>{title}</h2>{children}</section>; }
