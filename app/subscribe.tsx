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

/** מוצג פעם אחת מיד לאחר התחברות חדשה, ורק למי שאינו כבר ברשימה. */
export function SubscribeAfterLogin() {
  const [state, setState] = useState<"checking" | "offer" | "hidden">("checking");

  useEffect(() => {
    if (sessionStorage.getItem("rosh-berosh-show-subscribe") !== "1") return;
    sessionStorage.removeItem("rosh-berosh-show-subscribe");
    let active = true;
    fetch("/api/subscribers", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then((data) => { if (active) setState(data?.subscribed ? "hidden" : "offer"); })
      .catch(() => { if (active) setState("hidden"); });
    return () => { active = false; };
  }, []);

  if (state !== "offer") return null;
  return <div className="subscribe-overlay" role="dialog" aria-modal="true" aria-labelledby="subscribe-after-login-title">
    <section className="subscribe-dialog">
      <button className="subscribe-close" type="button" aria-label="לא עכשיו" onClick={() => setState("hidden")}>×</button>
      <p className="kicker">ברוכים הבאים לראש בראש</p>
      <h2 id="subscribe-after-login-title">רוצים לקבל עדכונים?</h2>
      <p>הצטרפו לרשימת התפוצה וקבלו עדכונים על המצעד, התוצאות וההצבעות הבאות.</p>
      <SubscribeCard heading="ההרשמה לוקחת רגע" blurb="נשתמש בכתובת ה־Google שאיתה התחברתם — בלי למלא טופס." />
      <button className="subscribe-later" type="button" onClick={() => setState("hidden")}>לא עכשיו</button>
    </section>
  </div>;
}
