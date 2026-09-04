"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadSubscribersXlsx } from "./xlsx-export";
import "./subscribers-panel.css";

type Subscriber = { id: string; email: string; name?: string | null; source?: string | null; consentedAt?: number | null; unsubscribedAt?: number | null; createdAt: number };

export function SubscribersPanel({ onMessage }: { onMessage(text: string): void }) {
  const [rows, setRows] = useState<Subscriber[]>([]);
  const [active, setActive] = useState(0);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (search: string, removed: boolean) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (removed) params.set("removed", "1");
      const response = await fetch(`/api/admin/subscribers?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRows(data.subscribers ?? []); setActive(data.active ?? 0); setTotal(data.total ?? 0);
    } catch { onMessage("טעינת רשימת התפוצה נכשלה."); } finally { setLoading(false); }
  }, [onMessage]);

  // חיפוש עם השהיה קצרה, כדי שכל הקשה לא תפנה לשרת.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(query, showRemoved); }, query ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query, showRemoved]);

  const addOne = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = { email: (form.elements.namedItem("email") as HTMLInputElement).value, name: (form.elements.namedItem("name") as HTMLInputElement).value };
    setBusy(true);
    try {
      const response = await fetch("/api/admin/subscribers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      form.reset(); onMessage("הכתובת נוספה לרשימה.");
      await load(query, showRemoved);
    } catch (caught) { onMessage(caught instanceof Error ? caught.message : "ההוספה נכשלה."); } finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const content = await file.text();
      const response = await fetch("/api/admin/subscribers/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      onMessage(`נמצאו ${data.found} כתובות · נוספו ${data.added} · כבר היו ברשימה ${data.duplicates}${data.skipped ? ` · ${data.skipped} שורות ללא כתובת תקינה` : ""}.`);
      await load(query, showRemoved);
    } catch (caught) { onMessage(caught instanceof Error ? caught.message : "הייבוא נכשל."); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  };

  const removeOne = async (email: string, purge: boolean) => {
    if (!window.confirm(purge ? `למחוק לצמיתות את ${email}?` : `להסיר את ${email} מרשימת התפוצה?`)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/subscribers", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, purge }) });
      if (!response.ok) throw new Error();
      await load(query, showRemoved);
    } catch { onMessage("הפעולה נכשלה."); } finally { setBusy(false); }
  };

  const copyAll = async () => {
    const list = rows.filter((row) => !row.unsubscribedAt).map((row) => row.email).join(", ");
    try { await navigator.clipboard.writeText(list); onMessage(`הועתקו ${rows.filter((r) => !r.unsubscribedAt).length} כתובות.`); }
    catch { onMessage("ההעתקה נכשלה. אפשר להוריד קובץ אקסל במקום."); }
  };

  const sourceLabel = (source?: string | null) => source === "import" ? "ייבוא" : source === "admin" ? "הוספה ידנית" : "האתר";

  return <>
    <AdminSection title="רשימת התפוצה">
      <p className="panel-help">כל מי שביקש לקבל עדכונים מהאתר, בתוספת כתובות שיובאו מרשימות קיימות. ההרשמה בקו הטלפון מנוהלת בנפרד ואינה מגיעה לכאן.</p>
      <div className="subscriber-stats"><div><b>{active.toLocaleString("he-IL")}</b><small>נמענים פעילים</small></div><div><b>{(total - active).toLocaleString("he-IL")}</b><small>הוסרו</small></div></div>
      <div className="subscriber-toolbar">
        <input className="subscriber-search" placeholder="חיפוש לפי כתובת או שם" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="subscriber-check"><input type="checkbox" checked={showRemoved} onChange={(event) => setShowRemoved(event.target.checked)} />הצגת מי שהוסר</label>
        <button type="button" disabled={busy || !rows.length} onClick={copyAll}>העתקת הכתובות</button>
        <button type="button" disabled={busy || !rows.length} onClick={() => downloadSubscribersXlsx(rows, `rosh-berosh-subscribers-${new Date().toISOString().slice(0, 10)}.xlsx`)}>הורדה לאקסל</button>
      </div>
      {loading ? <p className="loading">טוען…</p> : !rows.length ? <p className="panel-help">{query ? "לא נמצאו תוצאות לחיפוש." : "אין עדיין נמענים ברשימה."}</p> : <div className="subscriber-table-wrap"><table className="subscriber-table">
        <thead><tr><th>כתובת דוא״ל</th><th>שם</th><th>מקור</th><th>נרשם</th><th /></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className={row.unsubscribedAt ? "removed" : ""}>
          <td dir="ltr" className="subscriber-email">{row.email}</td>
          <td>{row.name || "—"}</td>
          <td>{sourceLabel(row.source)}</td>
          <td>{new Date(row.createdAt < 1_000_000_000_000 ? row.createdAt * 1000 : row.createdAt).toLocaleDateString("he-IL")}</td>
          <td className="subscriber-actions">{row.unsubscribedAt
            ? <button type="button" disabled={busy} onClick={() => removeOne(row.email, true)}>מחיקה</button>
            : <button type="button" disabled={busy} onClick={() => removeOne(row.email, false)}>הסרה</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </AdminSection>

    <AdminSection title="הוספת כתובת">
      <form className="artist-form" onSubmit={addOne}>
        <input name="email" type="email" placeholder="כתובת דוא״ל" dir="ltr" required />
        <input name="name" placeholder="שם (לא חובה)" />
        <button disabled={busy}>הוספה לרשימה</button>
      </form>
    </AdminSection>

    <AdminSection title="ייבוא רשימה קיימת">
      <p className="panel-help">קובץ CSV או TXT. כל שורה יכולה להיות כתובת בלבד, או שם וכתובת מופרדים בפסיק. כתובות שכבר ברשימה לא ישוכפלו, ושורת כותרת נדלגת מאליה.</p>
      <label className="file-field">בחירת קובץ<input ref={fileInput} type="file" accept=".csv,.txt,text/csv,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} /></label>
    </AdminSection>
  </>;
}

function AdminSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="admin-panel"><h2>{title}</h2>{children}</section>; }
