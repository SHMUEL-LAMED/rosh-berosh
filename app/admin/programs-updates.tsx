"use client";

/* דף העדכונים של אתר התוכניות — העורך בניהול. לכל עדכון: סרגל (קישור על מילה מסומנת, הדגשה,
   צירוף קובץ), קבצים מצורפים (עולים לאחסון של האתר, נפתחים/יורדים בשמם), כפתורי קישור ותצוגה
   מקדימה. הטקסט נשמר בסימון [מילה](כתובת) ו־**מודגש** ומצויר באתר ב־RoshUI.updateText.
   שינוי שמסתיים אחרי העלאה מוצא את העדכון לפי המזהה שלו — הרשימה יכולה להשתנות בינתיים. */

import type { ChangeEvent } from "react";
import { useRef, useState } from "react";
import { errorText, today, uploadFile, type Catalog, type Update, type UpdateFile, type UpdateLink } from "./programs-core";
import { Switch } from "./programs-ui";
import { badLinks, fileKindOf, fmtSize, parseUpdateText, updateUrl } from "./update-text";

type Mutate = (fn: (current: Catalog) => Catalog) => void;
type Patch = (fields: Partial<Update> | ((u: Update) => Partial<Update>)) => void;

/** הכפתורים של העדכון; קישור ישן (שדה link) מוצג ככפתור "לפרטים" */
const linksOf = (u: Update): UpdateLink[] => (u.links.length ? u.links : u.link ? [{ label: "לפרטים", url: u.link }] : []);

export function UpdatesEditor({ updates, mutate, onMessage }: { updates: Update[]; mutate: Mutate; onMessage(message: string): void }) {
  const setList = (fn: (list: Update[]) => Update[]) => mutate((c) => ({ ...c, settings: { ...c.settings, updates: fn(c.settings.updates) } }));
  const patch = (id: string): Patch => (fields) => setList((list) => list.map((u) => (u.id === id ? { ...u, ...(typeof fields === "function" ? fields(u) : fields) } : u)));
  const add = () => setList((list) => [{ id: `u-${Date.now().toString(36)}`, date: today(), title: "", text: "", link: "", pinned: false, links: [], files: [] }, ...list]);
  return <>
    <button type="button" className="prog-primary" onClick={add}>+ עדכון חדש</button>
    <div className="prog-updates">
      {updates.map((u) => <UpdateCard key={u.id} u={u} patch={patch(u.id)} remove={() => { if (confirm("למחוק את העדכון?")) setList((list) => list.filter((x) => x.id !== u.id)); }} onMessage={onMessage} />)}
      {!updates.length && <p className="panel-help">עדיין אין עדכונים.</p>}
    </div>
  </>;
}

type Linker = { start: number; end: number; text: string; url: string; editing: boolean };

function UpdateCard({ u, patch, remove, onMessage }: { u: Update; patch: Patch; remove(): void; onMessage(message: string): void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [linker, setLinker] = useState<Linker | null>(null);
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(0);
  const links = linksOf(u);

  /** מחליף את הטקסט המסומן; הסמן נשאר אחרי מה שנכנס */
  const replace = (start: number, end: number, insert: string) => {
    const text = u.text.slice(0, start) + insert + u.text.slice(end);
    patch({ text });
    requestAnimationFrame(() => { const ta = area.current; if (ta) { ta.focus(); ta.setSelectionRange(start + insert.length, start + insert.length); } });
  };
  const selection = () => { const ta = area.current; return ta ? { start: ta.selectionStart, end: ta.selectionEnd } : { start: u.text.length, end: u.text.length }; };
  const openLinker = (preset: Partial<Linker> = {}) => {
    const { start, end } = selection();
    const picked = u.text.slice(start, end), md = picked.match(/^\[([^\]]*)\]\(([^)]*)\)$/);   // סימנו קישור קיים — עורכים אותו
    setLinker({ start, end, text: md ? md[1] : picked.trim(), url: md ? md[2] : "", editing: !!md, ...preset });
  };
  const applyLinker = (unlink = false) => {
    if (!linker) return;
    const text = linker.text.replace(/[[\]\n]+/g, " ").trim();
    let url = linker.url.trim();
    if (!unlink) {
      if (!text) return onMessage("כתבו את הטקסט שיהיה קישור.");
      if (url && !/^[a-z][a-z0-9+.-]*:|^[/.#]|\.html\b/i.test(url)) url = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url) ? `mailto:${url}` : `https://${url}`;   // www.… או כתובת מייל
      if (!updateUrl(url)) return onMessage("הכתובת לא תקינה. היא צריכה להתחיל ב־https://");
    }
    replace(linker.start, linker.end, unlink ? text : `[${text}](${url.replace(/\s/g, "%20").replace(/\)/g, "%29")})`);
    setLinker(null);
  };
  const bold = () => {
    const { start, end } = selection(), picked = u.text.slice(start, end);
    if (!picked.trim()) { onMessage("סמנו קודם את המילים שרוצים להדגיש."); area.current?.focus(); return; }
    const m = picked.match(/^\*\*([\s\S]*)\*\*$/);
    replace(start, end, m ? m[1] : `**${picked.trim()}**`);
  };
  /** מעלה קבצים לעדכון ומחזיר את מה שעלה (כדי לקשר מילה לקובץ אחרי ההעלאה) */
  const upload = async (files: File[]): Promise<UpdateFile[]> => {
    const done: UpdateFile[] = [];
    setBusy((n) => n + 1);
    for (const file of files) {
      if (u.files.length + done.length >= 10) { onMessage("אפשר לצרף עד 10 קבצים לעדכון."); break; }
      try {
        setStatus(`מעלים את ${file.name}…`);
        const url = await uploadFile(file, u.id, "file", (pct) => setStatus(`מעלים את ${file.name} — ${pct}%`));
        const added = { name: file.name.replace(/\.[^.]+$/, ""), url, size: file.size, type: file.type || "" };
        done.push(added);
        patch((x) => ({ files: [...x.files, added] }));
      } catch (error) { setStatus(errorText(error, "ההעלאה נכשלה.")); setBusy((n) => n - 1); return done; }
    }
    setStatus(""); setBusy((n) => n - 1);
    if (done.length) onMessage(done.length === 1 ? "הקובץ צורף. כשתפרסמו, הוא יופיע באתר." : `${done.length} קבצים צורפו. כשתפרסמו, הם יופיעו באתר.`);
    return done;
  };
  const onAttach = (event: ChangeEvent<HTMLInputElement>) => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ""; if (files.length) void upload(files); };
  const onLinkerUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return;
    const [added] = await upload([file]);
    if (added) setLinker((l) => (l ? { ...l, url: added.url, text: l.text || added.name } : l));
  };
  const setLinks = (next: UpdateLink[]) => patch({ links: next, link: "" });
  const warnings = [...badLinks(u.text), ...links.filter((l) => l.url && !updateUrl(l.url)).map((l) => l.label || l.url)];

  return <article className={`prog-update${u.pinned ? " pinned" : ""}`} data-update={u.id}>
    <div className="prog-update-head">
      <input type="date" value={u.date} aria-label="תאריך" onChange={(e) => patch({ date: e.target.value })} />
      <input value={u.title} placeholder="כותרת" aria-label="כותרת" onChange={(e) => patch({ title: e.target.value })} />
      <Switch on={u.pinned} onClick={() => patch((x) => ({ pinned: !x.pinned }))}>נעוץ למעלה</Switch>
      <button type="button" className="danger" onClick={remove}>מחיקה</button>
    </div>
    <div className="prog-update-tools" role="toolbar" aria-label="עיצוב העדכון">
      <button type="button" data-tool="link" onClick={() => openLinker()} title="סמנו מילה בטקסט ולחצו">🔗 קישור על מילה</button>
      <button type="button" data-tool="bold" onClick={bold} title="סמנו מילים ולחצו"><b>מודגש</b></button>
      <label className="prog-update-attach">📎 צירוף קובץ<input type="file" multiple onChange={onAttach} disabled={busy > 0} /></label>
      <small>סמנו מילה בטקסט ולחצו „קישור” — אפשר לקשר אותה לכתובת או לקובץ.</small>
    </div>
    <textarea ref={area} value={u.text} placeholder="תוכן העדכון. כתובת שמדביקים הופכת לקישור לבד." aria-label="תוכן העדכון" onChange={(e) => patch({ text: e.target.value })} />

    {linker && <div className="prog-linker">
      <div className="prog-two">
        <label><span>הטקסט שיהיה קישור</span><input data-linker="text" value={linker.text} placeholder="למשל: לחצו כאן" autoFocus={!linker.text} onChange={(e) => setLinker({ ...linker, text: e.target.value })} /></label>
        <label><span>לאן הקישור מוביל</span><input data-linker="url" dir="ltr" value={linker.url} placeholder="https://…" autoFocus={!!linker.text} onChange={(e) => setLinker({ ...linker, url: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLinker(); } }} /></label>
      </div>
      <div className="prog-linker-files">
        {u.files.length > 0 && <small>או קובץ מצורף:</small>}
        {u.files.map((f, j) => <button type="button" key={`${f.url}-${j}`} onClick={() => setLinker({ ...linker, url: f.url, text: linker.text || f.name })}>📎 {f.name || "קובץ"}</button>)}
        <label className="prog-update-attach">⬆ העלאת קובץ לקישור<input type="file" onChange={onLinkerUpload} disabled={busy > 0} /></label>
      </div>
      <div className="prog-linker-actions">
        <button type="button" className="prog-primary" data-linker="apply" onClick={() => applyLinker()}>{linker.editing ? "עדכון הקישור" : "הוספת הקישור"}</button>
        <button type="button" onClick={() => setLinker(null)}>ביטול</button>
        {linker.editing && <button type="button" onClick={() => applyLinker(true)}>הסרת הקישור</button>}
      </div>
    </div>}
    {status && <span className="prog-progress" role="status">{busy > 0 && <i aria-hidden="true" />}{status}</span>}

    {u.files.length > 0 && <div className="prog-update-files"><span className="prog-update-sub">קבצים מצורפים</span>
      {u.files.map((f, j) => <div key={`${f.url}-${j}`}>
        <span aria-hidden="true">{fileKindOf(f).icon}</span>
        <input value={f.name} aria-label="שם הקובץ באתר" placeholder="שם הקובץ" data-file-name onChange={(e) => patch((x) => ({ files: x.files.map((y, k) => (k === j ? { ...y, name: e.target.value } : y)) }))} />
        <small>{fmtSize(f.size)}</small>
        <a href={f.url} target="_blank" rel="noopener noreferrer">פתיחה</a>
        <button type="button" onClick={() => openLinker({ url: f.url })} title="סמנו מילה בטקסט ולחצו">🔗 על המילה המסומנת</button>
        <button type="button" className="danger" aria-label="הסרת הקובץ" onClick={() => { if (confirm(`להסיר את „${f.name || "הקובץ"}” מהעדכון?`)) patch((x) => ({ files: x.files.filter((_, k) => k !== j) })); }}>✕</button>
      </div>)}
    </div>}

    <div className="prog-update-buttons"><span className="prog-update-sub">כפתורי קישור{links.length ? "" : " (לא חובה)"}</span>
      {links.map((l, j) => <div key={j}>
        <input value={l.label} placeholder="כיתוב, למשל: להרשמה" aria-label="כיתוב הכפתור" maxLength={80} data-button-label onChange={(e) => setLinks(links.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)))} />
        <input dir="ltr" value={l.url} placeholder="https://…" aria-label="כתובת הכפתור" data-button-url onChange={(e) => setLinks(links.map((x, k) => (k === j ? { ...x, url: e.target.value } : x)))} />
        <button type="button" className="danger" aria-label="הסרת הכפתור" onClick={() => setLinks(links.filter((_, k) => k !== j))}>✕</button>
      </div>)}
      <button type="button" data-tool="button" onClick={() => (links.length >= 6 ? onMessage("אפשר עד 6 כפתורים בעדכון.") : setLinks([...links, { label: "", url: "" }]))}>+ כפתור קישור</button>
    </div>

    <details className="prog-update-preview" open={!!(u.text || u.files.length)}>
      <summary>כך זה ייראה באתר</summary>
      {warnings.length > 0 && <p className="prog-error">⚠ הכתובת לא תקינה ולא תהיה קישור: {warnings.join(", ")}. כתובת מתחילה ב־https://</p>}
      <UpdatePreview u={u} links={links} />
    </details>
  </article>;
}

/** העדכון כמו שיופיע בדף העדכונים */
function UpdatePreview({ u, links }: { u: Update; links: UpdateLink[] }) {
  const safeLinks = links.map((l) => ({ ...l, url: updateUrl(l.url) })).filter((l) => l.url);
  const external = (url: string) => (/^https?:/i.test(url) ? { target: "_blank", rel: "noopener noreferrer" } : {});
  if (!u.title && !u.text && !u.files.length) return <p className="panel-help">כתבו כותרת או תוכן כדי לראות איך זה ייראה.</p>;
  return <div className="prog-update-card">
    {u.title && <h3>{u.title}</h3>}
    {parseUpdateText(u.text).map((paragraph, p) => <p key={p}>{paragraph.map((line, l) => <span key={l}>{l > 0 && <br />}{line.map((s, k) => (s.kind === "link"
      ? <a key={k} href={s.url} {...external(s.url)} dir={s.bare ? "ltr" : undefined}>{s.text}</a>
      : s.kind === "bold" ? <strong key={k}>{s.text}</strong> : <span key={k}>{s.text}</span>))}</span>)}</p>)}
    {u.files.length > 0 && <ul className="prog-update-attachments">{u.files.map((f, j) => { const k = fileKindOf(f); return <li key={j}><a href={f.url} target="_blank" rel="noopener noreferrer"><span aria-hidden="true">{k.icon}</span><b>{f.name || "קובץ מצורף"}</b><small>{[k.label, fmtSize(f.size)].filter(Boolean).join(" · ")}</small></a></li>; })}</ul>}
    {safeLinks.length > 0 && <div className="prog-update-actions">{safeLinks.map((l, j) => <a key={j} href={l.url} {...external(l.url)}>{l.label || "לפרטים"} ←</a>)}</div>}
  </div>;
}
