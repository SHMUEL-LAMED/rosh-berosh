"use client";

/* חלק "מאזינים" של ניהול אתר התוכניות — מה שמעבר למספרים הבסיסיים:
   סטטיסטיקה מעמיקה (מאיפה מגיעים, מתי מאזינים, מה אוהבים, עד איפה שומעים
   והרגעים הכי חמים), תגובות המאזינים באישור מנהל, והתראות לטלפון. */

import { useState } from "react";
import { api, drainPush, errorText, fmtTime, label, n2, scheduled, streamUrl, when, PROGRAM_SITE, type ApiError, type Catalog, type Comment, type EpisodeStats, type Moments, type Stats } from "./programs-core";
import { Bars, HBars, Section } from "./programs-ui";

const SOURCE_NAMES: Record<string, string> = { email: "מייל (רשימת התפוצה)", whatsapp: "וואטסאפ", google: "גוגל", facebook: "פייסבוק", direct: "ישיר (קישור או כתובת)", internal: "מתוך האתר", other: "אחר" };
const byDate = (a: { date: string; number: number | null }, b: { date: string; number: number | null }) => b.date.localeCompare(a.date) || (b.number || 0) - (a.number || 0);

type EpisodeDeep = { stats: EpisodeStats | null; moments: Moments | null; error: string };

/* ---------- סטטיסטיקה מעמיקה ---------- */
export function DeepStats({ stats, data }: { stats: Stats; data: Catalog }) {
  const [picked, setPicked] = useState(""), [cache, setCache] = useState<Record<string, EpisodeDeep>>({});
  const name = (id: string) => { const e = data.episodes.find((x) => x.id === id); return e ? label(e) : "תוכנית שנמחקה"; };
  const sources = (stats.sources || []).filter((r) => Number(r.plays)).sort((a, b) => b.plays - a.plays);
  const hours = stats.hours || [], likes = (stats.likes || []).filter((r) => Number(r.likes)), moments = stats.moments || [];
  const withAudio = data.episodes.filter((e) => streamUrl(e)).slice().sort(byDate);
  const pick = async (id: string) => {
    setPicked(id);
    if (!id || cache[id]) return;
    const [st, mo] = await Promise.allSettled([api<EpisodeStats>(`/api/program/stats/episode/${encodeURIComponent(id)}`), api<Moments>(`/api/program/moments/${encodeURIComponent(id)}`)]);
    setCache((c) => ({ ...c, [id]: { stats: st.status === "fulfilled" ? st.value : null, moments: mo.status === "fulfilled" ? mo.value : null, error: st.status === "rejected" ? errorText(st.reason, "הטעינה נכשלה.") : "" } }));
  };
  const deep = picked ? cache[picked] : null;
  const hot = deep?.moments;
  const episode = data.episodes.find((e) => e.id === picked);
  let hotBars: Array<{ key: string; value: number; label: string; title: string }> = [];
  if (hot?.buckets.length) {
    const D = episode?.duration || Math.max(...hot.buckets.map((b) => b.at + 30));
    const per = Math.max(30, Math.ceil(D / 40 / 30) * 30);
    hotBars = Array.from({ length: Math.ceil(D / per) }, (_, i) => { const c = hot.buckets.filter((b) => b.at >= i * per && b.at < (i + 1) * per).reduce((n, b) => n + b.count, 0); return { key: String(i), value: c, label: i % 8 ? "" : fmtTime(i * per), title: `${fmtTime(i * per)}–${fmtTime((i + 1) * per)}: ${n2(c)}` }; });
  }
  return <>
    <div className="prog-two">
      <div><h3>מאיפה הגיעו המאזינים (30 יום)</h3>{sources.length ? <HBars rows={sources.map((r) => ({ label: SOURCE_NAMES[r.ref] || r.ref || "אחר", n: Number(r.plays) || 0 }))} /> : <p className="panel-help">עוד אין נתונים — הם מתחילים להיאסף מעכשיו.</p>}</div>
      <div><h3>באיזו שעה מאזינים (30 יום)</h3>{hours.some((h) => Number(h.plays)) ? <Bars ariaLabel="האזנות לפי שעה ביום" items={hours.map((h) => ({ key: String(h.hour), value: Number(h.plays) || 0, label: Number(h.hour) % 3 ? "" : String(h.hour).padStart(2, "0"), title: `${String(h.hour).padStart(2, "0")}:00 — ${n2(h.plays)} האזנות` }))} /> : <p className="panel-help">עוד אין נתונים.</p>}</div>
    </div>
    <div className="prog-two">
      <div>
        <h3>הכי אהובות (♥)</h3>{likes.length ? <ol className="prog-top">{likes.slice(0, 10).map((r) => <li key={r.id}><span>{name(r.id)}</span><b>♥ {n2(r.likes)}</b></li>)}</ol> : <p className="panel-help">עוד אף אחד לא סימן „אהבתי”.</p>}
        {!!moments.length && <><h3>הכי הרבה רגעים מסומנים</h3><ol className="prog-top">{moments.slice(0, 5).map((r) => <li key={r.id}><span>{name(r.id)}</span><b>♥ {n2(r.count)}</b></li>)}</ol></>}
      </div>
      <div>
        <h3>עד איפה מאזינים</h3>
        <select className="prog-select" value={picked} onChange={(e) => pick(e.target.value)} aria-label="תוכנית"><option value="">בחרו תוכנית…</option>{withAudio.map((e) => <option key={e.id} value={e.id}>{label(e)}</option>)}</select>
        {picked ? (!deep ? <p className="panel-help">טוענים…</p> : deep.error ? <p className="prog-error">{deep.error}</p> : deep.stats?.retention.some((r) => Number(r.listeners)) ? <><Bars ariaLabel="כמה מאזינים הגיעו לכל נקודה בתוכנית" items={deep.stats.retention.map((r) => ({ key: String(r.pct), value: Number(r.listeners) || 0, label: r.pct % 25 ? "" : `${r.pct}%`, title: `${r.pct}% מהתוכנית: ${n2(r.listeners)} מאזינים` }))} /><p className="panel-help">{n2(deep.stats.listeners)} מאזינים · {n2(deep.stats.plays)} האזנות. כל עמודה: כמה מאזינים הגיעו לנקודה הזו בתוכנית. ירידה חדה = שם עוזבים.</p></> : <p className="panel-help">עוד אין מספיק נתונים לתוכנית הזו.</p>) : <p className="panel-help">בחרו תוכנית כדי לראות באיזה רגע מאזינים מפסיקים לשמוע.</p>}
        {hot && (hot.buckets.length ? <><h3>הרגעים הכי חמים · {n2(hot.total)} מאזינים סימנו ♥</h3><Bars pink ariaLabel="כמה מאזינים סימנו כל חלק בתוכנית" items={hotBars} /><div className="prog-chips">{hot.top.map((t) => <span key={t.at} className="prog-chip static">♥ {fmtTime(t.at)} · {n2(t.count)}</span>)}</div></> : <><h3>הרגעים הכי חמים</h3><p className="panel-help">עוד אף מאזין לא סימן ♥ על רגע בתוכנית הזו.</p></>)}
      </div>
    </div>
  </>;
}

/* ---------- תגובות המאזינים: אישור, תשובה של המגישים, תגובה נבחרת ---------- */
type CommentsState = { comments: Comment[]; pending: number; error: string };
const FILTERS: Array<[string, string]> = [["pending", "ממתינות"], ["approved", "מוצגות"], ["hidden", "מוסתרות"], ["all", "הכול"]];

export function CommentsCard({ data, comments, onChange, onMessage }: { data: Catalog; comments: CommentsState | null; onChange(next: CommentsState): void; onMessage(message: string): void }) {
  const [filter, setFilter] = useState("pending"), [replies, setReplies] = useState<Record<string, string>>({});
  if (!comments) return <Section title="תגובות באתר"><p className="panel-help">טוענים את התגובות…</p></Section>;
  const name = (id: string) => { const e = data.episodes.find((x) => x.id === id); return e ? label(e) : "תוכנית שנמחקה"; };
  const shown = comments.comments.filter((c) => filter === "all" || c.status === filter);
  const count = (st: string) => comments.comments.filter((c) => c.status === st).length;
  const withList = (list: Comment[]) => onChange({ ...comments, comments: list, pending: list.filter((c) => c.status === "pending").length });
  const moderate = async (id: string, body: Record<string, unknown>) => {
    try { const r = await api<{ comment: Comment }>("/api/program/comments/moderate", { method: "POST", body: JSON.stringify({ id, ...body }) }); withList(comments.comments.map((c) => (c.id === id && r.comment ? r.comment : c))); return true; }
    catch (error) { onMessage(errorText(error, "הפעולה נכשלה.")); return false; }
  };
  const remove = async (id: string) => {
    if (!confirm("למחוק את התגובה לתמיד?")) return;
    try { await api("/api/program/comments", { method: "DELETE", body: JSON.stringify({ id }) }); withList(comments.comments.filter((c) => c.id !== id)); }
    catch (error) { onMessage(errorText(error, "המחיקה נכשלה.")); }
  };
  return <Section title="תגובות באתר" aside={comments.pending ? <strong className="prog-badge warn">{comments.pending} ממתינות</strong> : undefined}>
    <p className="panel-help">תגובה מופיעה באתר רק אחרי שאישרתם אותה. אפשר לענות בשם המגישים, ולסמן „תגובה נבחרת” שתופיע ראשונה. תגובה על רגע בתוכנית מופיעה גם כסימן על פס ההתקדמות.</p>
    {comments.error && <p className="prog-error">{comments.error}</p>}
    <div className="prog-segmented" role="group" aria-label="סינון תגובות">{FILTERS.map(([k, t]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{t}{k !== "all" ? ` (${count(k)})` : ""}</button>)}</div>
    {shown.length ? <div className="prog-messages">{shown.map((c) => <article key={c.id} className={c.status === "pending" ? "unread" : ""}>
      <header><b>{c.name || "מאזין"}</b>{c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}<small>על „{name(c.episodeId)}”{c.at != null ? ` · ברגע ${fmtTime(c.at)}` : ""} · {when(c.createdAt)}</small>{c.pinned && <strong className="prog-badge">★ נבחרת</strong>}{c.status === "hidden" && <strong className="prog-badge off">מוסתרת</strong>}</header>
      <p>{c.text}</p>
      <label className="prog-field"><span>תשובת המגישים (לא חובה)</span><textarea className="prog-reply" maxLength={1000} placeholder="תשובה שתופיע מתחת לתגובה" value={replies[c.id] ?? c.reply ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [c.id]: e.target.value }))} /></label>
      <div className="row-actions">
        {c.status !== "approved" && <button type="button" className="prog-primary" onClick={() => moderate(c.id, { status: "approved" })}>✓ אישור והצגה</button>}
        {c.status !== "hidden" && <button type="button" onClick={() => moderate(c.id, { status: "hidden" })}>הסתרה</button>}
        <button type="button" onClick={() => moderate(c.id, { pinned: !c.pinned, ...(c.pinned || c.status === "approved" ? {} : { status: "approved" }) })}>{c.pinned ? "ביטול „נבחרת”" : "★ תגובה נבחרת"}</button>
        <button type="button" onClick={async () => { if (await moderate(c.id, { reply: (replies[c.id] ?? c.reply ?? "").trim() })) { setReplies((r) => { const next = { ...r }; delete next[c.id]; return next; }); onMessage("התשובה נשמרה."); } }}>שמירת התשובה</button>
        <button type="button" className="danger" onClick={() => remove(c.id)}>מחיקה</button>
      </div>
    </article>)}</div> : <p className="panel-help">{filter === "pending" ? "✓ אין תגובות שממתינות לאישור." : "אין תגובות כאן."}</p>}
  </Section>;
}

/* ---------- התראות לטלפון: הודעה לכל המאזינים שביקשו ---------- */
export function PushCard({ data, count, onCount, onMessage }: { data: Catalog; count: number | null; onCount(next: number | null): void; onMessage(message: string): void }) {
  const [title, setTitle] = useState(""), [body, setBody] = useState(""), [url, setUrl] = useState(""), [busy, setBusy] = useState(false);
  const targets = data.episodes.filter((e) => e.visible && !scheduled(e)).slice().sort(byDate).slice(0, 40);
  const send = async () => {
    const t = title.trim(); if (!t) return onMessage("כתבו כותרת להתראה.");
    if (!confirm(`לשלוח את ההתראה "${t}" ל־${count ?? "כל"} המכשירים?`)) return;
    setBusy(true); onMessage("שולחים…");
    try {
      const r = await api<{ sent: number; remaining: number; removed: number }>("/api/program/push/send", { method: "POST", body: JSON.stringify({ title: t, body: body.trim(), url: new URL(url || "", PROGRAM_SITE).href }) });
      const sent = Number(r.remaining) ? await drainPush(Number(r.sent) || 0) : Number(r.sent) || 0;
      onMessage(sent === 1 ? "נשלח למכשיר אחד." : `נשלח ל־${sent} מכשירים.`); setTitle(""); setBody(""); setUrl("");
      if (r.removed) onCount(Math.max(0, (count || 0) - r.removed));
    } catch (error) { onMessage(`השליחה לא הצליחה: ${errorText(error, "")}`); }
    setBusy(false);
  };
  return <Section title="התראות לטלפון" aside={count != null ? <strong className="prog-badge">{n2(count)} מכשירים</strong> : undefined}>
    <p className="panel-help">{count != null ? `${n2(count)} מכשירים ביקשו לקבל התראות. ` : "מאזינים מפעילים התראות באזור האישי. "}בפרסום של תוכנית חדשה נשלחת התראה אוטומטית (אפשר לכבות את זה ליד כפתור הפרסום). כאן אפשר לשלוח הודעה משלכם.</p>
    <div className="prog-form">
      <label className="wide"><span>כותרת</span><input value={title} maxLength={80} placeholder="למשל: התוכנית החדשה עלתה!" onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="wide"><span>הטקסט</span><input value={body} maxLength={180} placeholder="משפט קצר" onChange={(e) => setBody(e.target.value)} /></label>
      <label className="wide"><span>לאן ההתראה פותחת</span><select value={url} onChange={(e) => setUrl(e.target.value)}><option value="">דף הבית</option>{targets.map((e) => <option key={e.id} value={`episode.html?ep=${encodeURIComponent(e.slug)}`}>{label(e)}</option>)}</select></label>
    </div>
    <div className="row-actions"><button type="button" className="prog-primary" disabled={busy} onClick={send}>{busy ? "שולחים…" : "שליחה לכולם ←"}</button></div>
  </Section>;
}

export const commentsError = (error: unknown) => ((error as ApiError)?.status === 404 ? "השרת עדיין לא עודכן לגרסה עם תגובות." : errorText(error, "טעינת התגובות נכשלה."));
