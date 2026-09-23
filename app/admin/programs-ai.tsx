"use client";

/* בינה מלאכותית בניהול אתר התוכניות (למנהלים בלבד):
   - לכל תוכנית: תמלול ההקלטה בחלקים (/api/program/ai/transcribe), תיאור
     וסיכום מהתמלול (/ai/summarize), הצעות לשם (/ai/titles), והתמלול עצמו
     (/ai/transcript) — שלעולם אינו חלק מהאתר.
   - לכל האתר: הגהת כתיב (/ai/proofread) עם רשימת תיקונים לאישור.
   מצב התמלול נשמר מחוץ לרכיב, כך שהוא ממשיך לרוץ גם כשעוברים לתוכנית אחרת. */

import { useEffect, useState } from "react";
import { api, copyText, createMapStore, errorText, label, uniq, type AiSummary, type ApiError, type Catalog, type Episode, type ProofResult, type Transcript } from "./programs-core";
import { Status } from "./programs-ui";

export type AiState = { running?: boolean; text?: string; error?: string; summary?: AiSummary | null; titles?: string[]; whatsapp?: string; titlesBusy?: boolean; transcript?: string | null; transcriptBusy?: boolean };
const ai = createMapStore<AiState>();
const EMPTY: AiState = {};

/**
 * תמלול בחלקים של 2MB: השרת מחזיר לכל חלק את מספר החלקים הכולל; חלק 0 מתחיל
 * תמלול חדש, וחלק אחר ממשיך תמלול קיים — ולכן תמלול שנקטע ממשיך מאיפה שעצר.
 */
async function transcribe(episodeId: string, onStep: (part: number, total: number) => void) {
  let have: Transcript | null = null;
  try { have = await api<Transcript>(`/api/program/ai/transcript/${encodeURIComponent(episodeId)}`); } catch { /* עוד אין */ }
  if (have && have.partsTotal > 0 && have.partsDone >= have.partsTotal && have.text.trim()) return;
  let part = have && have.partsTotal > 0 && have.partsDone > 0 && have.partsDone < have.partsTotal ? have.partsDone : 0;
  let total = part > 0 && have ? have.partsTotal : 1;
  while (part < total) {
    const r = await api<{ part: number; partsTotal: number; done: boolean }>("/api/program/ai/transcribe", { method: "POST", body: JSON.stringify({ episodeId, part }) });
    total = Number(r.partsTotal) || 1; part++;
    onStep(part, total);
  }
}

/** תמלול (אם צריך) ואז תיאור וסיכום; התוצאה נשמרת במצב של התוכנית ומוחזרת */
export async function aiRun(episodeId: string): Promise<AiSummary> {
  if (ai.get(episodeId)?.running) throw new Error("התמלול של התוכנית הזו כבר רץ.");
  ai.set(episodeId, { running: true, error: "", text: "מתמללים את ההקלטה…" });
  try {
    await transcribe(episodeId, (p, t) => ai.set(episodeId, { text: `מתמללים… ${Math.round((p / t) * 100)}% (חלק ${p} מתוך ${t})` }));
    ai.set(episodeId, { text: "כותבים תיאור וסיכום…" });
    const summary = await api<AiSummary>("/api/program/ai/summarize", { method: "POST", body: JSON.stringify({ episodeId }) });
    ai.set(episodeId, { summary, text: "" });
    return summary;
  } catch (error) {
    ai.set(episodeId, { error: errorText(error, "התמלול נכשל."), text: "" });
    throw error;
  } finally { ai.set(episodeId, { running: false }); }
}
/** מה נכנס לתוכנית מההצעה: התיאור והסיכום לשדה "על התוכנית", ומילות חיפוש ואורחים מתווספים */
export function summaryPatch(episode: Episode, sum: AiSummary): Partial<Episode> {
  return {
    description: [sum.description, sum.summary].map((x) => String(x || "").trim()).filter(Boolean).join("\n\n"),
    tags: uniq([...episode.tags, ...(sum.tags || [])]).slice(0, 12),
    guests: uniq([...episode.guests, ...(sum.guests || [])]).slice(0, 12),
  };
}

export function AiCard({ episode, onPatch, onMessage }: { episode: Episode; onPatch(fields: Partial<Episode>): void; onMessage(message: string): void }) {
  const st = ai.useEntry(episode.id) || EMPTY;
  const id = episode.id;
  const [automatic, setAutomatic] = useState<Transcript | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => api<Transcript>(`/api/program/ai/transcript/${encodeURIComponent(id)}`)
      .then((result) => { if (active) setAutomatic(result); }).catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [id]);
  const run = () => aiRun(id).catch(() => {});
  const titles = async () => {
    ai.set(id, { titlesBusy: true, error: "" });
    try { const r = await api<{ titles: string[]; whatsapp: string }>("/api/program/ai/titles", { method: "POST", body: JSON.stringify({ episodeId: id }) }); ai.set(id, { titles: r.titles || [], whatsapp: r.whatsapp || "" }); }
    catch (error) { ai.set(id, { error: (error as ApiError).status === 409 ? "קודם צריך לתמלל את ההקלטה (הכפתור „תמלול ויצירת תיאור”)." : errorText(error, "יצירת ההצעות נכשלה.") }); }
    ai.set(id, { titlesBusy: false });
  };
  const transcript = async () => {
    if (st.transcript != null) return ai.set(id, { transcript: null });
    ai.set(id, { transcriptBusy: true, error: "" });
    try { const r = await api<Transcript>(`/api/program/ai/transcript/${encodeURIComponent(id)}`); ai.set(id, { transcript: r.text || "", ...(!st.summary && r.summary ? { summary: r.summary } : {}) }); }
    catch (error) { ai.set(id, { transcript: "", error: (error as ApiError).status === 404 ? "עדיין אין תמלול לתוכנית הזו." : errorText(error, "טעינת התמלול נכשלה.") }); }
    ai.set(id, { transcriptBusy: false });
  };
  const apply = () => { if (!st.summary) return; onPatch(summaryPatch(episode, st.summary)); onMessage("התיאור והסיכום נכנסו לתוכנית. בדקו, ואז „פרסום התוכניות”."); };
  const sum = st.summary;
  return <section className="admin-panel prog-panel prog-ai">
    <header className="prog-panel-head"><h2>תיאור וסיכום מההקלטה</h2><strong className="prog-badge">AI</strong></header>
    <p className="panel-help">ההקלטה מתומללת אוטומטית ברקע אחרי הפרסום, בלי ללחוץ על כפתור. אפשר לצאת מהדף וההתקדמות תישמר. התמלול גלוי למנהלים בלבד.</p>
    {automatic?.automatic && <p className="panel-help" role="status">{automatic.partsTotal ? `תומללו ${automatic.partsDone} מתוך ${automatic.partsTotal} חלקים.` : "התמלול ממתין לתחילת העיבוד."}{automatic.automatic.error && ` ניסיון קודם נכשל: ${automatic.automatic.error} המערכת תנסה שוב.`}</p>}
    {automatic && !automatic.automatic && automatic.partsTotal > 0 && <p className="panel-help">התמלול הושלם ({automatic.partsDone} חלקים).</p>}
    <div className="row-actions">
      <button type="button" className="prog-primary" disabled={!!st.running} onClick={run}>{st.running ? "מעבדים…" : "יצירת תיאור וסיכום"}</button>
      <button type="button" disabled={!!st.transcriptBusy} onClick={transcript}>{st.transcript != null ? "הסתרת התמלול" : st.transcriptBusy ? "טוענים…" : "הצגת התמלול"}</button>
      <button type="button" disabled={!!st.titlesBusy} onClick={titles}>{st.titlesBusy ? "חושבים על שמות…" : "הצעות לשם התוכנית"}</button>
    </div>
    <Status text={st.text} error={st.error} />
    {!!st.titles?.length && <div className="prog-ai-result">
      <h3>הצעות לשם — לחיצה מחליפה את השם</h3>
      <div className="prog-chips">{st.titles.map((t) => <button key={t} type="button" className="prog-chip" onClick={() => { onPatch({ title: t }); onMessage("השם הוחלף. אפשר לערוך אותו בשדה „שם התוכנית”."); }}>{t}</button>)}</div>
      {st.whatsapp && <><h3>טקסט לוואטסאפ</h3><p className="prog-pre">{st.whatsapp}</p><div className="row-actions"><button type="button" onClick={async () => onMessage((await copyText(st.whatsapp || "")) ? "הועתק." : "ההעתקה לא הצליחה.")}>העתקה</button></div></>}
    </div>}
    {sum && <div className="prog-ai-result">
      <h3>ההצעה</h3>
      {sum.description && <p><b>תיאור:</b> {sum.description}</p>}
      {sum.summary && <p className="prog-pre"><b>סיכום:</b>{"\n"}{sum.summary}</p>}
      {!!sum.tags?.length && <p><b>מילות חיפוש:</b> {sum.tags.join(", ")}</p>}
      {!!sum.guests?.length && <p><b>אורחים:</b> {sum.guests.join(", ")}</p>}
      <div className="row-actions"><button type="button" className="prog-primary" onClick={apply}>הכנסה לתוכנית ←</button><small className="prog-hint">התיאור והסיכום נכנסים לשדה „על התוכנית”; אפשר לערוך אחר כך.</small></div>
    </div>}
    {st.transcript != null && <details className="prog-transcript" open><summary>התמלול (למנהלים בלבד)</summary><div className="prog-pre">{st.transcript || "עדיין אין תמלול."}</div></details>}
  </section>;
}

/* ---------- הגהה: השמות, התיאורים, ההודעה והעדכונים — תיקוני כתיב בלבד, כל אחד באישור ---------- */

const PROOF_MAX_ITEMS = 40, PROOF_MAX_CHARS = 38000;
type ProofState = { running: boolean; done: number; total: number; results: ProofResult[]; error: string };

/** איפה הטקסט יושב בטיוטה, ומה הערך שלו עכשיו */
function proofRead(data: Catalog, key: string): string | undefined {
  const [where, field] = key.split("|");
  if (where === "banner") return data.settings.banner.text;
  if (where.startsWith("update:")) { const u = data.settings.updates[Number(where.slice(7))]; return u ? String(u[field as "title" | "text"]) : undefined; }
  const e = data.episodes.find((x) => x.id === where); return e ? String(e[field as "title" | "description"]) : undefined;
}
function proofWrite(data: Catalog, key: string, value: string): Catalog {
  const [where, field] = key.split("|");
  if (where === "banner") return { ...data, settings: { ...data.settings, banner: { ...data.settings.banner, text: value } } };
  if (where.startsWith("update:")) { const i = Number(where.slice(7)); return { ...data, settings: { ...data.settings, updates: data.settings.updates.map((u, j) => (j === i ? { ...u, [field]: value } : u)) } }; }
  return { ...data, episodes: data.episodes.map((e) => (e.id === where ? { ...e, [field]: value } : e)) };
}
function proofLabel(data: Catalog, key: string) {
  const [where, field] = key.split("|");
  if (where === "banner") return "ההודעה בראש האתר";
  if (where.startsWith("update:")) return `עדכון · ${field === "title" ? "כותרת" : "תוכן"}`;
  const e = data.episodes.find((x) => x.id === where);
  return `${e ? label(e) : "תוכנית"} · ${field === "title" ? "השם" : "התיאור"}`;
}

export function ProofreadCard({ data, origin, mutate, onMessage, onOpen }: { data: Catalog; origin: Catalog; mutate(fn: (current: Catalog) => Catalog): void; onMessage(message: string): void; onOpen(episodeId: string | null): void }) {
  const [proof, setProof] = useState<ProofState | null>(null);
  const run = async (scope: "changed" | "all") => {
    if (proof?.running) return;
    if (scope === "all" && !confirm("לבדוק את האיות של כל השמות והתיאורים באתר? זה לוקח כדקה.")) return;
    const before = new Map(origin.episodes.map((e) => [e.id, e]));
    const eps = data.episodes.filter((e) => scope === "all" || !before.has(e.id) || (["title", "description"] as const).some((f) => before.get(e.id)![f] !== e[f]));
    const items: Array<{ key: string; text: string }> = [];
    for (const e of eps) for (const f of ["title", "description"] as const) if (e[f].trim().length > 1) items.push({ key: `${e.id}|${f}`, text: e[f] });
    if (data.settings.banner.text) items.push({ key: "banner|text", text: data.settings.banner.text });
    data.settings.updates.forEach((u, i) => { if (u.title) items.push({ key: `update:${i}|title`, text: u.title }); if (u.text) items.push({ key: `update:${i}|text`, text: u.text }); });
    if (!items.length) return onMessage(scope === "all" ? "אין טקסטים לבדוק." : "לא השתנה שום שם או תיאור מאז הפרסום.");
    const batches: Array<typeof items> = []; let cur: typeof items = [], size = 0;
    for (const it of items) { if (cur.length && (cur.length >= PROOF_MAX_ITEMS || size + it.text.length > PROOF_MAX_CHARS)) { batches.push(cur); cur = []; size = 0; } cur.push(it); size += it.text.length; }
    if (cur.length) batches.push(cur);
    const byKey = new Map(items.map((it) => [it.key, it.text]));
    const state: ProofState = { running: true, done: 0, total: batches.length, results: [], error: "" };
    setProof({ ...state });
    for (const batch of batches) {
      try {
        const r = await api<{ results: Array<{ key: string; fixed: string; changes: Array<{ from: string; to: string }> }> }>("/api/program/ai/proofread", { method: "POST", body: JSON.stringify({ items: batch }) });
        for (const x of r.results || []) { const original = byKey.get(x.key); if (x.fixed && original !== undefined && x.fixed !== original) state.results.push({ ...x, changes: x.changes || [], original }); }
      } catch (error) { state.error = errorText(error, "ההגהה נכשלה."); }
      state.done++; setProof({ ...state, results: [...state.results] });
    }
    setProof({ ...state, running: false, results: [...state.results] });
    onMessage(state.results.length ? `נמצאו הצעות תיקון ב־${state.results.length} טקסטים.` : "לא נמצאו שגיאות כתיב.");
  };
  const applyMany = (indexes: number[]) => {
    if (!proof) return;
    let n = 0;
    const results = proof.results.map((r) => ({ ...r }));
    mutate((current) => {
      let next = current;
      for (const i of indexes) {
        const r = results[i]; if (!r || r.applied || r.ignored) continue;
        if (proofRead(next, r.key) !== r.original) { r.stale = true; continue; }   // נערך בינתיים — לא דורסים
        next = proofWrite(next, r.key, r.fixed); r.applied = true; n++;
      }
      return next;
    });
    setProof({ ...proof, results });
    if (indexes.length === 1) onMessage(n ? "תוקן בטיוטה." : "הטקסט נערך אחרי הבדיקה — בדקו שוב.");
    else onMessage(`${n} טקסטים תוקנו בטיוטה. בדקו ולחצו „פרסום”.`);
  };
  const ignore = (i: number) => { if (proof) setProof({ ...proof, results: proof.results.map((r, j) => (j === i ? { ...r, ignored: true } : r)) }); };
  const open = proof ? proof.results.map((r, i) => ({ r, i })).filter(({ r }) => !r.applied && !r.ignored) : [];
  return <section className="admin-panel prog-panel">
    <header className="prog-panel-head"><h2>בדיקת איות</h2><strong className="prog-badge">{open.length ? `${open.length} הצעות` : "AI"}</strong></header>
    <p className="panel-help">ה־AI עובר על השמות, התיאורים, ההודעה והעדכונים, ומסמן שגיאות כתיב ורווחים חסרים — בלי לשנות ניסוח או שמות. כל תיקון נכנס לטיוטה רק אחרי שאישרתם.</p>
    <div className="row-actions">
      <button type="button" className="prog-primary" disabled={!!proof?.running} onClick={() => run("changed")}>בדיקת מה שהשתנה</button>
      <button type="button" disabled={!!proof?.running} onClick={() => run("all")}>בדיקת כל האתר</button>
      {open.length > 1 && <button type="button" onClick={() => applyMany(open.map(({ i }) => i))}>תיקון הכול</button>}
    </div>
    <Status text={proof?.running ? `בודקים… ${proof.done}/${proof.total}` : ""} error={proof?.error} />
    {proof && !proof.running && !proof.error && !proof.results.length && <p className="prog-note ok">✓ לא נמצאו שגיאות כתיב.</p>}
    {!!open.length && <ul className="prog-proof">{open.map(({ r, i }) => <li key={r.key}>
      <button type="button" className="prog-link" onClick={() => { const id = r.key.split("|")[0]; onOpen(data.episodes.some((e) => e.id === id) ? id : null); }}>{proofLabel(data, r.key)}</button>
      <div className="prog-proof-changes">{r.changes.slice(0, 12).map((c, j) => <span key={j}><del>{c.from || "·"}</del> ← <ins>{c.to || "·"}</ins></span>)}</div>
      {r.stale && <small className="prog-error">הטקסט נערך אחרי הבדיקה — בדקו שוב.</small>}
      <div className="row-actions"><button type="button" className="prog-primary" onClick={() => applyMany([i])}>תיקון</button><button type="button" onClick={() => ignore(i)}>התעלמות</button></div>
    </li>)}</ul>}
  </section>;
}
