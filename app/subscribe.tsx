"use client";

import { useEffect, useState } from "react";
import "./subscribe.css";

type Props = { heading?: string; blurb?: string };

/**
 * הרשמה לרשימת התפוצה בלחיצה אחת. הכתובת נלקחת מהחשבון המחובר, ולכן
 * אין כאן שדה להקלדה. הלחיצה על הכפתור היא ההסכמה המפורשת שהחוק דורש,
 * ולכן אין תיבת סימון מסומנת מראש ואין הרשמה אוטומטית בעקבות ההצבעה.
 * מי שכבר רשום לא רואה את הכרטיס בכלל, כדי שלא נבקש ממנו שוב.
 */
export function SubscribeCard({ heading = "רוצים לשמוע מאיתנו?", blurb = "הצטרפו לרשימת התפוצה של ראש בראש ותקבלו עדכון על תוצאות המצעד ועל התוכניות הבאות." }: Props) {
  const [state, setState] = useState<"checking" | "offer" | "done" | "hidden">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/subscribers", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then((data) => { if (active) setState(data?.subscribed ? "hidden" : "offer"); })
      // בלי תשובה מהשרת עדיף לא להציע הרשמה מאשר לבקש שוב ממי שכבר נרשם.
      .catch(() => { if (active) setState("hidden"); });
    return () => { active = false; };
  }, []);

  const subscribe = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/subscribers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "ההרשמה נכשלה.");
      setState("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ההרשמה נכשלה.");
    } finally { setBusy(false); }
  };

  if (state === "checking" || state === "hidden") return null;

  if (state === "done") return <section className="subscribe-card done">
    <span className="subscribe-mark">✓</span>
    <div><b>נרשמתם לרשימת התפוצה</b><small>נעדכן אתכם בדוא״ל של החשבון שאיתו התחברתם.</small></div>
  </section>;

  return <section className="subscribe-card">
    <div className="subscribe-copy"><b>{heading}</b><small>{blurb}</small></div>
    <button className="continue" type="button" disabled={busy} onClick={subscribe}>{busy ? "רושמים…" : "הרשמה לרשימת התפוצה"}</button>
    {error && <p className="subscribe-error">{error}</p>}
    <p className="subscribe-note">נשתמש בכתובת החשבון שאיתו התחברתם. אפשר להסיר אותה מהרשימה בכל עת.</p>
  </section>;
}
