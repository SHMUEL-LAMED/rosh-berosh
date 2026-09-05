"use client";

import { useEffect, useState } from "react";
import { downloadSubscribersXlsx } from "./xlsx-export";
import "./subscribers-panel.css";

type Subscriber = { id: string; email: string; name?: string | null; source?: string | null; consentedAt?: number | null; unsubscribedAt?: number | null; createdAt: number };

/** רשימת הנמענים בלבד, עם הורדה לאקסל. הרשימה נועדה להיות מיוצאת ולהיטען למערכת דיוור חיצונית. */
export function SubscribersPanel({ onMessage }: { onMessage(text: string): void }) {
  const [rows, setRows] = useState<Subscriber[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);

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
  }, [onMessage]);

  return <AdminSection title="רשימת התפוצה">
    <p className="panel-help">כל מי שביקש לקבל עדכונים מהאתר. ההרשמה בקו הטלפון מנוהלת בנפרד ואינה מגיעה לכאן.</p>
    <div className="subscriber-toolbar">
      <div className="subscriber-count"><b>{active.toLocaleString("he-IL")}</b> נמענים</div>
      <button type="button" disabled={loading || !rows.length} onClick={() => downloadSubscribersXlsx(rows, `rosh-berosh-subscribers-${new Date().toISOString().slice(0, 10)}.xlsx`)}>הורדה לאקסל</button>
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
