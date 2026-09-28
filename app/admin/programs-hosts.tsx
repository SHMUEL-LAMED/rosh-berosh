"use client";

/* ניהול המגישים של אתר התוכניות (settings.hosts): לכל מגיש תמונה, שורת תפקיד, כמה מילים,
   קישורים, העונות שהגיש (מהן נאספות התוכניות שלו בדף המגיש) והאם הוא מגיש כיום.
   הסדר כאן הוא הסדר באתר. הכול נכנס לטיוטה, ולאתר רק בפרסום. הכללים ב־worker/program-hosts.js. */

import type { ChangeEvent } from "react";
import { useState } from "react";
import { HOST_LIMITS } from "../../worker/program-hosts.js";
import { errorText, makeThumb, PROGRAM_SITE, uploadFile, type Catalog, type Host } from "./programs-core";
import { FilePick, Section, Status, Switch } from "./programs-ui";

type Mutate = (fn: (current: Catalog) => Catalog) => void;
const EMPTY: Host = { name: "", role: "", bio: "", photo: "", links: [], seasons: [], current: true };
const hueOf = (key: string) => { let h = 2166136261; for (const c of key) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; };
const initials = (name: string) => name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "?";
export const hostPageUrl = (name: string) => `${PROGRAM_SITE}guest.html?host=${encodeURIComponent(name)}`;

function Avatar({ host, size = 34 }: { host: Host; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  return host.photo
    ? <img className="guest-av" src={host.photo} alt="" style={style} />
    : <span className="guest-av" aria-hidden="true" style={{ ...style, background: `hsl(${hueOf(host.name)} 55% 42%)` }}>{initials(host.name)}</span>;
}

export function HostsSection({ data, mutate, onMessage }: { data: Catalog; mutate: Mutate; onMessage(message: string): void }) {
  const hosts = data.settings.hosts;
  const [open, setOpen] = useState<number | null>(null);
  const set = (fn: (list: Host[]) => Host[]) => mutate((cur) => ({ ...cur, settings: { ...cur.settings, hosts: fn(cur.settings.hosts) } }));
  const add = () => {
    if (hosts.length >= HOST_LIMITS.hosts) return;
    set((list) => [...list, { ...EMPTY, name: `מגיש ${list.length + 1}` }]);
    setOpen(hosts.length);
  };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= hosts.length) return; set((list) => { const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; return next; }); setOpen(open === i ? j : open === j ? i : open); };
  const remove = (i: number) => { if (!confirm(`להסיר את „${hosts[i].name}” מרשימת המגישים?`)) return; set((list) => list.filter((_, j) => j !== i)); setOpen(null); onMessage("המגיש הוסר מהטיוטה."); };

  return <Section title="המגישים" aside={<div className="row-actions"><strong className="prog-badge">{hosts.length}</strong><a className="prog-btn" href={`${PROGRAM_SITE}guest.html`} target="_blank" rel="noopener">המגישים והאורחים באתר ↗</a></div>}>
    <p className="panel-help">המגישים מופיעים בראש הדף „מגישים ואורחים” באתר, בסדר שכאן, וכל מגיש מקבל דף עם התוכניות מהעונות שהגיש. „מגיש כיום” מופיע בנפרד ממגישים לשעבר.</p>
    <div className="host-list">
      {hosts.map((host, i) => <div key={i} className={`host-row${open === i ? " open" : ""}`}>
        <button type="button" className="host-row-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
          <Avatar host={host} size={44} />
          <span><b>{host.name || "מגיש בלי שם"}</b><small>{[host.role, host.current ? "מגיש כיום" : "לשעבר", host.seasons.length ? `${host.seasons.length === 1 ? "עונה אחת" : `${host.seasons.length} עונות`}` : "בלי עונות"].filter(Boolean).join(" · ")}</small></span>
          <i aria-hidden="true">{open === i ? "▴" : "▾"}</i>
        </button>
        <div className="row-actions host-order">
          <button type="button" className="prog-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="למעלה">↑</button>
          <button type="button" className="prog-btn" disabled={i === hosts.length - 1} onClick={() => move(i, 1)} aria-label="למטה">↓</button>
        </div>
        {open === i && <HostEditor host={host} seasons={data.seasons} onChange={(fields) => set((list) => list.map((h, j) => (j === i ? { ...h, ...fields } : h)))} onRemove={() => remove(i)} onMessage={onMessage} />}
      </div>)}
      {!hosts.length && <p className="panel-help">אין מגישים — באתר לא יוצג החלק של המגישים.</p>}
    </div>
    {hosts.length < HOST_LIMITS.hosts && <button type="button" className="prog-primary" onClick={add}>+ מגיש</button>}
  </Section>;
}

function HostEditor({ host, seasons, onChange, onRemove, onMessage }: { host: Host; seasons: Catalog["seasons"]; onChange(fields: Partial<Host>): void; onRemove(): void; onMessage(message: string): void }) {
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const pickPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBusy("מעלים את התמונה…"); setError("");
    try {
      const blob = await squareThumb(file, 600);
      const url = await uploadFile(new File([blob], `host-${host.name.replace(/[^\p{L}\p{N}]+/gu, "-") || "photo"}.jpg`, { type: "image/jpeg" }), "hosts", "cover");
      onChange({ photo: url });
      onMessage("התמונה עלתה ונשמרה בטיוטה.");
    } catch (cause) { setError(errorText(cause, "העלאת התמונה נכשלה.")); }
    finally { setBusy(""); }
  };
  const toggleSeason = (id: string) => onChange({ seasons: host.seasons.includes(id) ? host.seasons.filter((s) => s !== id) : [...host.seasons, id] });

  return <div className="host-editor">
    <div className="guest-editor-top">
      <Avatar host={host} size={96} />
      <div className="prog-field"><span>תמונה</span>
        <div className="row-actions"><FilePick accept=".jpg,.jpeg,.png,.webp" disabled={!!busy} onChange={pickPhoto}>{busy ? "מעלים…" : host.photo ? "⬆ החלפת תמונה" : "⬆ העלאת תמונה"}</FilePick>{host.photo && <button type="button" className="danger" onClick={() => onChange({ photo: "" })}>הסרה</button>}</div>
        <Status text={busy} error={error} />
      </div>
    </div>
    <div className="prog-form">
      <label><span>שם</span><input value={host.name} maxLength={HOST_LIMITS.name} onChange={(e) => onChange({ name: e.target.value })} /></label>
      <label><span>שורת תפקיד</span><input value={host.role} maxLength={HOST_LIMITS.role} placeholder="למשל: מגיש ועורך מוזיקלי" onChange={(e) => onChange({ role: e.target.value })} /></label>
      <label className="wide"><span>כמה מילים על המגיש</span><textarea value={host.bio} maxLength={HOST_LIMITS.bio} rows={4} placeholder="מי הוא, מתי הצטרף לתוכנית, ומה הוא מביא לשידור" onChange={(e) => onChange({ bio: e.target.value })} /></label>
      <div className="prog-field wide"><span>העונות שהגיש <small>(מהן נאספות התוכניות שלו בדף המגיש)</small></span>
        <div className="row-actions">{seasons.map((s) => <label key={s.id} className="prog-check"><input type="checkbox" checked={host.seasons.includes(s.id)} onChange={() => toggleSeason(s.id)} /> {s.title}</label>)}</div>
      </div>
      <div className="prog-field wide"><Switch on={host.current} onClick={() => onChange({ current: !host.current })}>{host.current ? "מגיש כיום" : "מגיש לשעבר"}</Switch></div>
      <div className="prog-field wide"><span>קישורים</span>
        {host.links.map((link, i) => <div key={i} className="prog-link-row"><input value={link.label} placeholder="מה זה? (למשל: יוטיוב)" onChange={(e) => onChange({ links: host.links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)) })} /><input dir="ltr" value={link.url} placeholder="https://…" onChange={(e) => onChange({ links: host.links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)) })} /><button type="button" className="danger" onClick={() => onChange({ links: host.links.filter((_, j) => j !== i) })}>✕</button></div>)}
        {host.links.length < HOST_LIMITS.links && <button type="button" className="prog-btn" onClick={() => onChange({ links: [...host.links, { label: "", url: "" }] })}>+ הוספת קישור</button>}
      </div>
    </div>
    <div className="row-actions"><a className="prog-btn" href={hostPageUrl(host.name)} target="_blank" rel="noopener">הדף באתר ↗</a><button type="button" className="danger" onClick={onRemove}>הסרת המגיש</button></div>
  </div>;
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
