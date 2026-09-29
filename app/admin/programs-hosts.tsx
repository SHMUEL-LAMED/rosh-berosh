"use client";

/* ניהול המגישים של אתר התוכניות (settings.hosts): לכל מגיש שם, שורת תפקיד, העונות שהגיש והאם
   הוא מגיש כיום. באתר אין דף מגיש: שמות המגישים בדפי התוכניות מובילים לארכיון המסונן לפי המגיש.
   תמונה, כמה מילים וקישורים שנשמרו בעבר נשארים בנתונים אבל אינם נערכים כאן ואינם מוצגים.
   הכול נכנס לטיוטה, ולאתר רק בפרסום. הכללים ב־worker/program-hosts.js. */

import { useState } from "react";
import { HOST_LIMITS } from "../../worker/program-hosts.js";
import { PROGRAM_SITE, type Catalog, type Host } from "./programs-core";
import { Section, Switch } from "./programs-ui";

type Mutate = (fn: (current: Catalog) => Catalog) => void;
const EMPTY: Host = { name: "", role: "", bio: "", photo: "", links: [], seasons: [], current: true };
/** הארכיון באתר, מסונן לפי המגיש — לשם מובילים השמות בדפי התוכניות */
export const hostPageUrl = (name: string) => `${PROGRAM_SITE}archive.html?guest=${encodeURIComponent(name)}`;

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

  return <Section title="המגישים" aside={<div className="row-actions"><strong className="prog-badge">{hosts.length}</strong><a className="prog-btn" href={`${PROGRAM_SITE}archive.html`} target="_blank" rel="noopener">הארכיון באתר ↗</a></div>}>
    <p className="panel-help">המגישים נשמרים עם הקטלוג, בסדר שכאן. באתר אין דף מגיש: שמות המגישים בדפי התוכניות מובילים לארכיון המסונן לפי המגיש. „מגיש כיום” מסומן בנפרד ממגישים לשעבר.</p>
    <div className="host-list">
      {hosts.map((host, i) => <div key={i} className={`host-row${open === i ? " open" : ""}`}>
        <button type="button" className="host-row-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
          <span><b>{host.name || "מגיש בלי שם"}</b><small>{[host.role, host.current ? "מגיש כיום" : "לשעבר", host.seasons.length ? `${host.seasons.length === 1 ? "עונה אחת" : `${host.seasons.length} עונות`}` : "בלי עונות"].filter(Boolean).join(" · ")}</small></span>
          <i aria-hidden="true">{open === i ? "▴" : "▾"}</i>
        </button>
        <div className="row-actions host-order">
          <button type="button" className="prog-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="למעלה">↑</button>
          <button type="button" className="prog-btn" disabled={i === hosts.length - 1} onClick={() => move(i, 1)} aria-label="למטה">↓</button>
        </div>
        {open === i && <HostEditor host={host} seasons={data.seasons} onChange={(fields) => set((list) => list.map((h, j) => (j === i ? { ...h, ...fields } : h)))} onRemove={() => remove(i)} />}
      </div>)}
      {!hosts.length && <p className="panel-help">אין מגישים — באתר לא יוצג החלק של המגישים.</p>}
    </div>
    {hosts.length < HOST_LIMITS.hosts && <button type="button" className="prog-primary" onClick={add}>+ מגיש</button>}
  </Section>;
}

function HostEditor({ host, seasons, onChange, onRemove }: { host: Host; seasons: Catalog["seasons"]; onChange(fields: Partial<Host>): void; onRemove(): void }) {
  const toggleSeason = (id: string) => onChange({ seasons: host.seasons.includes(id) ? host.seasons.filter((s) => s !== id) : [...host.seasons, id] });

  return <div className="host-editor">
    <div className="prog-form">
      <label><span>שם</span><input value={host.name} maxLength={HOST_LIMITS.name} onChange={(e) => onChange({ name: e.target.value })} /></label>
      <label><span>שורת תפקיד</span><input value={host.role} maxLength={HOST_LIMITS.role} placeholder="למשל: מגיש ועורך מוזיקלי" onChange={(e) => onChange({ role: e.target.value })} /></label>
      <div className="prog-field wide"><span>העונות שהגיש</span>
        <div className="row-actions">{seasons.map((s) => <label key={s.id} className="prog-check"><input type="checkbox" checked={host.seasons.includes(s.id)} onChange={() => toggleSeason(s.id)} /> {s.title}</label>)}</div>
      </div>
      <div className="prog-field wide"><Switch on={host.current} onClick={() => onChange({ current: !host.current })}>{host.current ? "מגיש כיום" : "מגיש לשעבר"}</Switch></div>
    </div>
    <div className="row-actions"><a className="prog-btn" href={hostPageUrl(host.name)} target="_blank" rel="noopener">התוכניות באתר ↗</a><button type="button" className="danger" onClick={onRemove}>הסרת המגיש</button></div>
  </div>;
}
