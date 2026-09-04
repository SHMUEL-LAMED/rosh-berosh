"use client";

import { useState } from "react";
import "./subscribe.css";

type Props = { defaultEmail?: string; defaultName?: string; heading?: string; blurb?: string };

/**
 * הרשמה לרשימת התפוצה. הלחיצה על הכפתור היא ההסכמה המפורשת שהחוק דורש,
 * ולכן אין כאן תיבת סימון מסומנת מראש ואין הרשמה אוטומטית בעקבות ההצבעה.
 */
export function SubscribeCard({ defaultEmail = "", defaultName = "", heading = "רוצים לשמוע מאיתנו?", blurb = "הצטרפו לרשימת התפוצה של ראש בראש ותקבלו עדכון על תוצאות המצעד ועל התוכניות הבאות." }: Props) {
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/subscribers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), name: defaultName }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "ההרשמה נכשלה.");
      setStatus("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ההרשמה נכשלה.");
    } finally { setBusy(false); }
  };

  if (status === "done") return <section className="subscribe-card done">
    <span className="subscribe-mark">✓</span>
    <div><b>נרשמתם לרשימת התפוצה</b><small>{email}</small></div>
  </section>;

  return <section className="subscribe-card">
    <div className="subscribe-copy"><b>{heading}</b><small>{blurb}</small></div>
    <form className="subscribe-form" onSubmit={submit}>
      <input
        type="email"
        inputMode="email"
        dir="ltr"
        required
        placeholder="כתובת דוא״ל"
        value={email}
        onChange={(event) => { setEmail(event.target.value); setError(""); }}
        aria-label="כתובת דוא״ל לרשימת התפוצה"
      />
      <button className="continue" disabled={busy || !email.trim()}>{busy ? "רושמים…" : "הרשמה"}</button>
    </form>
    {error && <p className="subscribe-error">{error}</p>}
    <p className="subscribe-note">אפשר להסיר את הכתובת מהרשימה בכל עת.</p>
  </section>;
}
