"use client";

/* ניהול האורחים של אתר התוכניות: כל מי שמופיע בשדה "אורחים" של התוכניות, עם פרופיל
   (תמונה, שורת תפקיד, כמה מילים, קישורים) לדף האורח באתר (guest.html?g=…), שינוי שם
   ואיחוד כפילויות בכל התוכניות יחד, והשלמת אורחים מהסיכומים של התמלולים.
   הכול נכנס לטיוטה, ולאתר רק בפרסום — כמו שאר ניהול התוכניות. הכללים ב־worker/program-guests.js. */

import type { ChangeEvent } from "react";
import { useMemo, useState } from "react";
import { applyGuestSuggestions, collectGuests, guestKey, guestSuggestions, removeGuest, renameGuest } from "../../worker/program-guests.js";
import { api, errorText, label, makeThumb, PROGRAM_SITE, uploadFile, type Catalog, type Episode, type GuestProfile } from "./programs-core";
import { runJob, stopJob, useJob } from "./programs-jobs";
import { FilePick, Section, Status } from "./programs-ui";

type Mutate = (fn: (current: Catalog) => Catalog) => void;
type Guest = { key: string; name: string; spellings: string[]; episodeIds: string[]; count: number; profile: GuestProfile | null };
type Suggestion = { episodeId: string; title: string; add: Array<{ name: string; checked: boolean; reason: string }> };

const EMPTY: GuestProfile = { name: "", role: "", bio: "", photo: "", links: [] };
const hueOf = (key: string) => { let h = 2166136261; for (const c of key) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; };
const initials = (name: string) => name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("");
export const guestPageUrl = (name: string) => `${PROGRAM_SITE}guest.html?g=${encodeURIComponent(name)}`;

function Avatar({ guest, size = 34 }: { guest: { key: string; name: string; profile: GuestProfile | null }; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  return guest.profile?.photo
    ? <img className="guest-av" src={guest.profile.photo} alt="" style={style} />
    : <span className="guest-av" aria-hidden="true" style={{ ...style, background: `hsl(${hueOf(guest.key)} 55% 42%)` }}>{initials(guest.name)}</span>;
}

export function GuestsSection({ data, mutate, onMessage }: { data: Catalog; mutate: Mutate; onMessage(message: string): void }) {
  const guests = useMemo(() => collectGuests(data.episodes, data.settings.guests) as Guest[], [data.episodes, data.settings.guests]);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const k = guestKey(query);
  const shown = k ? guests.filter((g) => g.key.includes(k) || (g.profile?.role || "").toLowerCase().includes(k)) : guests;
  const current = guests.find((g) => g.key === selectedKey) || null;
  const withProfile = guests.filter((g) => g.profile).length;

  return <>
    <SuggestCard data={data} mutate={mutate} onMessage={onMessage} />
    <div className="prog-workspace" data-tour="guests-list">
      <aside className="admin-panel prog-list">
        <input className="prog-search" type="search" placeholder="חיפוש אורח…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="חיפוש אורח" />
        <div className="prog-filters"><small>{guests.length ? `${guests.length} אורחים · ${withProfile} עם פרופיל` : "עדיין אין אורחים"}</small><a className="prog-btn" href={`${PROGRAM_SITE}guest.html`} target="_blank" rel="noopener">כל האורחים באתר ↗</a></div>
        <div className="prog-items" role="listbox" aria-label="אורחים">
          {shown.map((g) => <button key={g.key} type="button" role="option" aria-selected={g.key === selectedKey} className={`prog-item guest-item${g.key === selectedKey ? " selected" : ""}${g.count ? "" : " muted"}`} onClick={() => setSelectedKey(g.key)}>
            <Avatar guest={g} />
            <span><b>{g.name}</b><small>{g.count ? `${g.count === 1 ? "תוכנית אחת" : `${g.count} תוכניות`}` : "אין תוכניות"}{g.profile?.role ? ` · ${g.profile.role}` : ""}{g.profile ? "" : " · בלי פרופיל"}{g.spellings.length > 1 ? " · כמה כתיבים" : ""}</small></span>
          </button>)}
          {!shown.length && <p className="panel-help">{guests.length ? "אין אורח שמתאים לחיפוש." : "אורחים נכנסים מהשדה „אורחים” בכל תוכנית, או מהחיפוש בתמלולים למעלה."}</p>}
        </div>
      </aside>
      <div className="prog-editor">
        {current ? <GuestEditor key={current.key} guest={current} guests={guests} data={data} mutate={mutate} onMessage={onMessage} onSelect={setSelectedKey} />
          : <Section title="דף לכל אורח"><p className="panel-help">בחרו אורח מהרשימה כדי להוסיף לו תמונה, כמה מילים וקישורים. כל אורח מקבל באתר דף משלו עם כל התוכניות שהתארח בהן — והשמות שלו בדפי התוכניות מובילים אליו.</p>
            {guests.some((g) => g.spellings.length > 1) && <p className="panel-help">✦ יש אורחים שהשם שלהם נכתב בכמה צורות — פתחו אותם כדי לאחד לכתיב אחד.</p>}</Section>}
      </div>
    </div>
  </>;
}

/* ---------- עורך אורח ---------- */

function GuestEditor({ guest, guests, data, mutate, onMessage, onSelect }: { guest: Guest; guests: Guest[]; data: Catalog; mutate: Mutate; onMessage(message: string): void; onSelect(key: string | null): void }) {
  const profile = guest.profile || { ...EMPTY, name: guest.name };
  const [name, setName] = useState(guest.name);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const [addTo, setAddTo] = useState("");
  const episodes = data.episodes.filter((e) => guest.episodeIds.includes(e.id));
  const others = guests.filter((g) => g.key !== guest.key);
  const live = episodes.some((e) => e.visible);

  /** עדכון הפרופיל בטיוטה (נוצר בשינוי הראשון) */
  const setProfile = (fields: Partial<GuestProfile>) => mutate((cur) => {
    const list = cur.settings.guests.filter((p) => guestKey(p.name) !== guest.key);
    const base = cur.settings.guests.find((p) => guestKey(p.name) === guest.key) || { ...EMPTY, name: guest.name };
    return { ...cur, settings: { ...cur.settings, guests: [...list, { ...base, ...fields }] } };
  });
  /** שינוי שם / איחוד: בכל התוכניות, והפרופיל עובר לשם החדש (פרופיל קיים של היעד נשמר ומושלם) */
  const rename = (to: string, merge = false) => {
    const target = to.replace(/\s+/g, " ").trim();
    if (!target) return;
    const toKey = guestKey(target);
    const into = guests.find((g) => g.key === toKey && g.key !== guest.key);
    if (into && !merge && !confirm(`כבר יש אורח בשם „${into.name}”. לאחד את „${guest.name}” איתו? התוכניות של שניהם יופיעו בדף אחד.`)) { setName(guest.name); return; }
    mutate((cur) => {
      const mine = cur.settings.guests.find((p) => guestKey(p.name) === guest.key);
      const theirs = cur.settings.guests.find((p) => guestKey(p.name) === toKey && toKey !== guest.key);
      const rest = cur.settings.guests.filter((p) => guestKey(p.name) !== guest.key && guestKey(p.name) !== toKey);
      // באיחוד: מה שכבר מולא אצל היעד נשאר, וחסרים מושלמים מהפרופיל של האורח שמתאחד אליו
      const filled = Object.fromEntries(Object.entries(theirs || {}).filter(([, v]) => (Array.isArray(v) ? v.length : !!v)));
      const merged = theirs || mine ? [{ ...EMPTY, ...mine, ...filled, name: into ? into.name : target }] : [];
      return { ...cur, episodes: renameGuest(cur.episodes, guest.name, into ? into.name : target) as Episode[], settings: { ...cur.settings, guests: [...rest, ...merged] } };
    });
    onSelect(toKey);
    onMessage(into ? `„${guest.name}” אוחד עם „${into.name}”.` : `השם עודכן בכל ${guest.count === 1 ? "התוכנית" : `${guest.count} התוכניות`}.`);
  };
  const unify = () => {
    // כל הכתיבים חולקים את אותו מפתח, ולכן החלפה אחת מאחדת את כולם
    mutate((cur) => ({ ...cur, episodes: renameGuest(cur.episodes, guest.name, guest.name) as Episode[] }));
    onMessage(`כל הכתיבים אוחדו ל„${guest.name}”.`);
  };
  const remove = () => {
    if (!confirm(`להסיר את „${guest.name}” מ${guest.count === 1 ? "התוכנית" : `כל ${guest.count} התוכניות`} ולמחוק את הפרופיל שלו?`)) return;
    mutate((cur) => ({ ...cur, episodes: removeGuest(cur.episodes, guest.name) as Episode[], settings: { ...cur.settings, guests: cur.settings.guests.filter((p) => guestKey(p.name) !== guest.key) } }));
    onSelect(null);
    onMessage("האורח הוסר. הפרסום יעדכן את האתר.");
  };
  const addToEpisode = (id: string) => {
    const asPanelist = profile.role === "חבר פאנל";
    mutate((cur) => ({ ...cur, episodes: cur.episodes.map((e) => {
      if (e.id !== id) return e;
      const target = asPanelist ? e.panelists : e.guests;
      const other = asPanelist ? e.guests : e.panelists;
      if (target.some((name) => guestKey(name) === guest.key) || other.some((name) => guestKey(name) === guest.key)) return e;
      return asPanelist ? { ...e, panelists: [...e.panelists, guest.name] } : { ...e, guests: [...e.guests, guest.name] };
    }) }));
    setAddTo("");
  };
  const pickPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBusy("מעלים את התמונה…"); setError("");
    try {
      // תמונה ריבועית קטנה (480 פיקסלים) — נטענת מהר בכרטיסים ובדף האורח
      const blob = await squareThumb(file, 480);
      const url = await uploadFile(new File([blob], `guest-${guest.key.replace(/[^\p{L}\p{N}]+/gu, "-")}.jpg`, { type: "image/jpeg" }), "guests", "cover");
      setProfile({ photo: url });
      onMessage("התמונה עלתה ונשמרה בטיוטה.");
    } catch (cause) { setError(errorText(cause, "העלאת התמונה נכשלה.")); }
    finally { setBusy(""); }
  };

  return <>
    <Section id="tour-guest-editor" title={guest.name} aside={<div className="row-actions">{live ? <a className="prog-btn" href={guestPageUrl(guest.name)} target="_blank" rel="noopener">הדף באתר ↗</a> : <small className="panel-help">הדף יופיע באתר כשתהיה תוכנית מוצגת עם האורח</small>}</div>}>
      <div className="guest-editor-top">
        <Avatar guest={{ ...guest, profile }} size={96} />
        <div className="prog-field"><span>תמונה</span>
          <div className="row-actions"><FilePick accept=".jpg,.jpeg,.png,.webp" disabled={!!busy} onChange={pickPhoto}>{busy ? "מעלים…" : profile.photo ? "⬆ החלפת תמונה" : "⬆ העלאת תמונה"}</FilePick>{profile.photo && <button type="button" className="danger" onClick={() => setProfile({ photo: "" })}>הסרה</button>}</div>
          <Status text={busy} error={error} />
        </div>
      </div>
      <div className="prog-form">
        <label><span>השם (בכל התוכניות)</span><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const next = name.replace(/\s+/g, " ").trim(); if (!next) setName(guest.name); else if (next !== guest.name) rename(next); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></label>
        <label><span>שורת תפקיד</span><input value={profile.role} maxLength={80} placeholder="למשל: זמר ומלחין" onChange={(e) => setProfile({ role: e.target.value })} /></label>
        <label className="wide"><span>כמה מילים על האורח</span><textarea value={profile.bio} maxLength={1500} rows={4} placeholder="מי הוא, במה הוא עוסק, ומה היה מיוחד בתוכניות איתו" onChange={(e) => setProfile({ bio: e.target.value })} /></label>
        <div className="prog-field wide"><span>קישורים (יוטיוב, אתר, אלבום…)</span>
          {profile.links.map((link, i) => <div key={i} className="prog-link-row"><input value={link.label} placeholder="מה זה? (למשל: יוטיוב)" onChange={(e) => setProfile({ links: profile.links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)) })} /><input dir="ltr" value={link.url} placeholder="https://…" onChange={(e) => setProfile({ links: profile.links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)) })} /><button type="button" className="danger" onClick={() => setProfile({ links: profile.links.filter((_, j) => j !== i) })}>✕</button></div>)}
          {profile.links.length < 6 && <button type="button" className="prog-btn" onClick={() => setProfile({ links: [...profile.links, { label: "", url: "" }] })}>+ הוספת קישור</button>}
        </div>
      </div>
    </Section>

    <Section id="tour-guest-episodes" title="התוכניות עם האורח" aside={<strong className="prog-badge">{guest.count}</strong>}>
      {guest.spellings.length > 1 && <p className="prog-note">השם נכתב בתוכניות בכמה צורות: {guest.spellings.map((s) => `„${s}”`).join(", ")}. <button type="button" className="prog-btn" onClick={unify}>איחוד לכתיב „{guest.name}”</button></p>}
      {episodes.length ? <ul className="guest-episodes">{episodes.map((e) => <li key={e.id}><b>{label(e)}</b><small>{e.date || "בלי תאריך"}{e.visible ? "" : " · מוסתרת"}</small></li>)}</ul> : <p className="panel-help">האורח לא מופיע כרגע באף תוכנית.</p>}
      <div className="guest-tools">
        <select value={addTo} onChange={(e) => { setAddTo(e.target.value); if (e.target.value) addToEpisode(e.target.value); }} aria-label="הוספת האורח לתוכנית"><option value="">+ הוספה לתוכנית…</option>{data.episodes.filter((e) => !guest.episodeIds.includes(e.id)).map((e) => <option key={e.id} value={e.id}>{label(e)}{e.date ? ` (${e.date})` : ""}</option>)}</select>
        {others.length > 0 && <select value="" onChange={(e) => { const into = others.find((g) => g.key === e.target.value); if (into && confirm(`לאחד את „${guest.name}” עם „${into.name}”? השם „${guest.name}” יוחלף ב„${into.name}” בכל התוכניות.`)) rename(into.name, true); }} aria-label="איחוד עם אורח אחר"><option value="">איחוד עם אורח אחר…</option>{others.map((g) => <option key={g.key} value={g.key}>{g.name} ({g.count})</option>)}</select>}
        <button type="button" className="danger" onClick={remove}>הסרת האורח</button>
      </div>
    </Section>
  </>;
}

/** תמונה ריבועית מהמרכז, להצגה בעיגול */
async function squareThumb(file: File, size: number): Promise<Blob> {
  try {
    const img = await createImageBitmap(file);
    const side = Math.min(img.width, img.height), out = Math.min(size, side);
    const canvas = document.createElement("canvas"); canvas.width = out; canvas.height = out;
    const x = canvas.getContext("2d"); if (!x) throw new Error();
    x.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error())), "image/jpeg", 0.85));
  } catch { return makeThumb(file, size); }
}

/* ---------- השלמה מהתמלולים ---------- */

function SuggestCard({ data, mutate, onMessage }: { data: Catalog; mutate: Mutate; onMessage(message: string): void }) {
  const [state, setState] = useState<{ loading: boolean; error: string; suggestions: Suggestion[] | null; pending: string[]; scanned: number }>({ loading: false, error: "", suggestions: null, pending: [], scanned: 0 });
  const job = useJob("guest-summaries");
  const scan = async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const r = await api<{ items: Array<{ episodeId: string; guests: string[] }>; pending: string[] }>("/api/program/ai/guests");
      const ids = new Set(data.episodes.map((e) => e.id));
      setState({ loading: false, error: "", suggestions: guestSuggestions(data.episodes, r.items, data.seasons) as Suggestion[], pending: r.pending.filter((id) => ids.has(id)), scanned: r.items.filter((item) => ids.has(item.episodeId)).length });
    } catch (cause) { setState((s) => ({ ...s, loading: false, error: errorText(cause, "החיפוש בתמלולים נכשל.") })); }
  };
  const summarize = () => runJob("guest-summaries", state.pending, async (id) => { await api("/api/program/ai/summarize", { method: "POST", body: JSON.stringify({ episodeId: id }) }); }, { concurrency: 1, what: "סיכומים" }, (message) => { onMessage(message); void scan(); });
  const toggle = (episodeId: string, name: string) => setState((s) => ({ ...s, suggestions: s.suggestions?.map((row) => (row.episodeId !== episodeId ? row : { ...row, add: row.add.map((a) => (a.name === name ? { ...a, checked: !a.checked } : a)) })) ?? null }));
  const setAll = (on: boolean) => setState((s) => ({ ...s, suggestions: s.suggestions?.map((row) => ({ ...row, add: row.add.map((a) => ({ ...a, checked: on && !a.reason })) })) ?? null }));
  const picked = (state.suggestions || []).map((row) => ({ episodeId: row.episodeId, names: row.add.filter((a) => a.checked).map((a) => a.name) })).filter((row) => row.names.length);
  const total = picked.reduce((n, row) => n + row.names.length, 0);
  const apply = () => {
    mutate((cur) => ({ ...cur, episodes: applyGuestSuggestions(cur.episodes, picked) as Episode[] }));
    onMessage(`נוספו ${total} אורחים ל־${picked.length} תוכניות. הם יופיעו באתר אחרי הפרסום.`);
    setState((s) => ({ ...s, suggestions: null }));
  };

  return <Section title="השלמת אורחים מהתמלולים" aside={state.suggestions ? <strong className="prog-badge">{state.suggestions.length}</strong> : undefined}>
    <p className="panel-help">בכל סיכום של תמלול הבינה המלאכותית רושמת מי התארח. כאן אוספים את כולם בבת אחת ומוסיפים לתוכניות — רק מה שתסמנו, ורק לטיוטה.</p>
    <div className="row-actions" data-tour="guests-scan">
      <button type="button" className="prog-primary" disabled={state.loading} onClick={() => void scan()}>{state.loading ? "מחפשים…" : state.suggestions ? "חיפוש מחדש" : "🔎 חיפוש אורחים בתמלולים"}</button>
      {state.suggestions && state.pending.length > 0 && (job?.running
        ? <><Status text={`יוצרים סיכומים… ${job.text}`} /><button type="button" className="prog-btn" onClick={() => stopJob("guest-summaries")}>עצירה</button></>
        : <button type="button" className="prog-btn" onClick={summarize}>יצירת סיכום ל־{state.pending.length} תוכניות מתומללות</button>)}
    </div>
    <Status error={state.error} />
    {state.suggestions && <>
      <p className="panel-help">נסרקו {state.scanned} סיכומים{state.pending.length ? ` · ל־${state.pending.length} תוכניות יש תמלול בלי סיכום` : ""}.{!state.scanned && !state.pending.length ? " עדיין אין תוכניות מתומללות — התמלול רץ לבד על כל הקלטה חדשה, ואפשר גם להפעיל אותו מעורך התוכנית." : ""}</p>
      {state.suggestions.length ? <>
        <div className="row-actions"><button type="button" className="prog-btn" onClick={() => setAll(true)}>סימון המומלצים</button><button type="button" className="prog-btn" onClick={() => setAll(false)}>ניקוי</button></div>
        <ul className="guest-suggestions">{state.suggestions.map((row) => <li key={row.episodeId}><b>{row.title}</b><div>{row.add.map((a) => <label key={a.name} className={`prog-check${a.reason ? " doubt" : ""}`} title={a.reason || undefined}><input type="checkbox" checked={a.checked} onChange={() => toggle(row.episodeId, a.name)} /> {a.name}{a.reason && <small> — {a.reason}</small>}</label>)}</div></li>)}</ul>
        <button type="button" className="prog-primary" disabled={!total} onClick={apply}>הוספת {total} אורחים ל־{picked.length} תוכניות</button>
      </> : <p className="prog-note">אין אורחים חדשים להוסיף — כל מה שנמצא בסיכומים כבר רשום בתוכניות.</p>}
    </>}
  </Section>;
}
