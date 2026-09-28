"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import "./ivr-line-settings.css";

type NumericKey = "votingWaitSeconds" | "adminWaitSeconds" | "menuRepeats";
type Source = "admin" | "default";
type LineSettingsView = {
  settings: { postVoteTransfer: string; transferNumber: string } & Record<NumericKey, number | null>;
  effective: { postVoteTransfer: string; transferEnabled: boolean } & Record<NumericKey, number>;
  sources: Record<"postVoteTransfer" | NumericKey, Source>;
  defaults: { postVoteTransfer: string } & Record<NumericKey, number>;
  limits: Record<NumericKey, { min: number; max: number }>;
  updatedAt: number | null;
  updatedBy: string | null;
};
type Draft = { transferEnabled: boolean; transferNumber: string } & Record<NumericKey, string>;

const NUMERIC_FIELDS: { key: NumericKey; label: string; unit: string; help: string }[] = [
  { key: "votingWaitSeconds", label: "זמן המתנה להקשה בתפריטי ההצבעה", unit: "שניות", help: "כמה זמן הקו ממתין להקשה אחרי שתפריט הוקרא. חל גם על שאלות האישור והרשימות הקצרות בקו הניהול." },
  { key: "adminWaitSeconds", label: "זמן המתנה בתפריטי הקודים של קו הניהול", unit: "שניות", help: "בתפריט הקודים וברשימות הארוכות של קו הניהול: כמה זמן הקו ממתין לספרה נוספת אחרי הספרה הראשונה." },
  { key: "menuRepeats", label: "מספר החזרות על תפריט כשלא הוקש דבר", unit: "חזרות", help: "0 — התפריט מושמע פעם אחת, כמו עד היום. בתפריטי ההצבעה, אחרי החזרות מוצע למתקשר מעבר לקו הראשי. שימו לב: עם חזרות, הקשה על סולמית עלולה להשמיע את התפריט שוב לפני שאלת המעבר — אחרי שינוי כדאי לבדוק בשיחת ניסיון." },
];

const draftOf = (view: LineSettingsView): Draft => ({
  transferEnabled: view.settings.postVoteTransfer !== "off",
  transferNumber: view.settings.transferNumber || "",
  votingWaitSeconds: view.settings.votingWaitSeconds?.toString() ?? "",
  adminWaitSeconds: view.settings.adminWaitSeconds?.toString() ?? "",
  menuRepeats: view.settings.menuRepeats?.toString() ?? "",
});

const sourceLabel = (source: Source) => source === "admin" ? "נקבע כאן" : "ברירת מחדל, אלא אם הוגדר אחרת בשרת הקו";

/** הגדרות הקו הטלפוני שנשמרות באתר: שירות הקו קורא אותן בכל שיחה (עם שמירה לדקה), כך שאין צורך לשנות משתני סביבה ולפרוס מחדש. */
export function IvrLineSettings({ onMessage }: { onMessage(message: string): void }) {
  const [view, setView] = useState<LineSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/ivr-line-settings", { cache: "no-store" })
      .then((response) => response.json().then((data) => { if (!response.ok) throw new Error(data.error); return data as LineSettingsView; }))
      .then((data) => { if (!active) return; setView(data); setDraft(draftOf(data)); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    const number = draft.transferNumber.trim();
    const numeric = (value: string) => value.trim() === "" ? null : Number(value);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/ivr-line-settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postVoteTransfer: draft.transferEnabled ? number : "off", transferNumber: number, votingWaitSeconds: numeric(draft.votingWaitSeconds), adminWaitSeconds: numeric(draft.adminWaitSeconds), menuRepeats: numeric(draft.menuRepeats) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "שמירת הגדרות הקו נכשלה.");
      setView(result); setDraft(draftOf(result));
      onMessage("הגדרות הקו נשמרו. הקו יתחיל להשתמש בהן בתוך כדקה.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "שמירת הגדרות הקו נכשלה.");
    } finally {
      setBusy(false);
    }
  };

  if (failed) return <section className="line-settings"><h3>הגדרות הקו</h3><p className="panel-help">לא ניתן לטעון כרגע את הגדרות הקו.</p></section>;
  if (!view || !draft) return <section className="line-settings"><h3>הגדרות הקו</h3><p className="panel-help">טוען…</p></section>;

  const transferNow = view.effective.transferEnabled ? `מעביר ל־${view.effective.postVoteTransfer}` : "ההעברה כבויה — השיחה מסתיימת בניתוק";
  return <section className="line-settings">
    <h3>הגדרות הקו</h3>
    <p className="panel-help">הקו קורא את ההגדרות מהאתר, והשינויים תופסים בתוך כדקה בלי לשנות דבר בשרת ובלי פריסה מחדש. שדה ריק משאיר את ברירת המחדל של שרת הקו (משתני הסביבה שלו, ואם אינם — הערכים הקבועים).</p>
    <form className="line-settings-form" onSubmit={save}>
      <label className="master-switch"><span>להעביר לקו הראשי בסיום השיחה</span><input type="checkbox" checked={draft.transferEnabled} onChange={(event) => setDraft({ ...draft, transferEnabled: event.target.checked })} /></label>
      <div className="line-settings-row">
        <label>מספר להעברת השיחה בסיום<input type="tel" inputMode="tel" dir="ltr" placeholder={view.defaults.postVoteTransfer} value={draft.transferNumber} disabled={!draft.transferEnabled} onChange={(event) => setDraft({ ...draft, transferNumber: event.target.value })} /></label>
        <small>בפועל: {transferNow} · {sourceLabel(view.sources.postVoteTransfer)}</small>
        <small>ספרות בלבד, 9 או 10 ספרות שמתחילות ב־0. גם הקשת סולמית בתפריטי ההצבעה מעבירה למספר הזה, אחרי אישור.</small>
      </div>
      {NUMERIC_FIELDS.map((field) => {
        const { min, max } = view.limits[field.key];
        return <div className="line-settings-row" key={field.key}>
          <label>{field.label}<input type="number" inputMode="numeric" min={min} max={max} step={1} placeholder={String(view.defaults[field.key])} value={draft[field.key]} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} /></label>
          <small>בפועל: {view.effective[field.key]} {field.unit} · {sourceLabel(view.sources[field.key])} · טווח מותר {min}–{max}</small>
          <small>{field.help}</small>
        </div>;
      })}
      <button disabled={busy}>{busy ? "שומר…" : "שמירת הגדרות הקו"}</button>
      {view.updatedAt && <small className="line-settings-updated">נשמר לאחרונה {new Date(view.updatedAt * 1000).toLocaleString("he-IL")}{view.updatedBy ? ` על ידי ${view.updatedBy}` : ""}</small>}
    </form>
  </section>;
}
