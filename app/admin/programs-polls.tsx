"use client";

/* הסקרים של אתר התוכניות: שאלה למאזינים עם תשובות (אפשר עם תמונה לכל תשובה), איפה הסקר מוצג,
   מתי הוא נפתח ונסגר, ומי רואה את התוצאות — אותם שדות בדיוק כמו בניהול הישן
   (rosh-berosh-2/assets/js/admin-polls.js), כדי ש־polls.js באתר יציג אותם כמו תמיד.

   ההגדרה נשמרת בטיוטה (settings.polls) ועולה לאתר ב„פרסום התוכניות” — כמו בניהול הישן, וכי האתר
   קורא את הסקרים מהקטלוג המפורסם. ההצבעות, התוצאות החיות והאיפוס — ישר בשרת ומיד
   (/api/program/polls/results, /api/program/polls/reset). סקר שלא נערך נשמר ומתפרסם בדיוק כמו שהוא.
   הכללים המשותפים ב־worker/program-polls-shared.js. */

import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import "./programs-polls.css";
import { blankPoll, filledOptions, newPollId, normPollDraft, POLL_LIMITS, pollForSave, pollPlaces, pollProblems, pollState, untilIn } from "../../worker/program-polls-shared.js";
import { israelWallClock } from "../../worker/program-schedule.js";
import { api, errorText, fmtDate, label, n2, shrinkImage, uploadFile, when, type Catalog, type Episode, type Poll, type PollOption } from "./programs-core";
import { FilePick, Section, Status, Switch } from "./programs-ui";
import { useHoldUpdate } from "../update-hold";

type Mutate = (fn: (current: Catalog) => Catalog) => void;
type Result = { total: number; counts: Record<string, number>; lastVoteAt: number | null; published: boolean; open: boolean; closed: boolean };
type Editing = { draft: Poll; isNew: boolean; dirty: boolean };

const HUES = [42, 24, 8, 340, 300, 270, 240, 210, 190, 160, 130, 90];
const RESULTS: Array<[Poll["results"], string, string]> = [
  ["after", "אחרי שהצביעו", "מי שהצביע רואה מיד איך כולם הצביעו."],
  ["always", "תמיד", "כולם רואים את התוצאות, גם לפני שהצביעו."],
  ["closed", "רק כשההצבעה נסגרת", "מתח עד הסוף — מתאים להכרזה בתוכנית."],
  ["admin", "רק אתם", "המאזינים לא רואים תוצאות; אתם רואים כאן בניהול."],
];
const PLACES: Array<[keyof Omit<Poll["show"], "episodes">, string]> = [["home", "🏠 דף הבית"], ["archive", "🗂️ הארכיון"], ["me", "👤 האזור האישי"], ["allEpisodes", "🎙️ בכל דפי התוכניות"]];
const opt = (text = "", sub = ""): PollOption => ({ id: newPollId(8), label: text, sub, image: "" });
const TEMPLATES: Array<[string, () => Partial<Poll>]> = [
  ["🎵 השיר של השבוע", () => ({ title: "השיר של השבוע", question: "איזה שיר הכי אהבתם בתוכנית?", layout: "list", optionShape: "rounded", options: [opt("", "הזמר"), opt("", "הזמר"), opt("", "הזמר")] })],
  ["🎤 מי הזמר שלכם", () => ({ title: "מצעד", question: "מי הזמר שלכם?", layout: "grid", optionShape: "circle", optionSize: "l", options: [opt(), opt(), opt(), opt()] })],
  ["👍 כן / לא", () => ({ title: "מה דעתכם?", question: "", layout: "list", optionShape: "circle", options: [opt("כן"), opt("לא"), opt("עוד לא החלטתי")] })],
  ["⭐ דירוג התוכנית", () => ({ title: "דרגו", question: "כמה נהניתם מהתוכנית?", layout: "grid", optionSize: "s", optionShape: "circle", options: ["😍 מאוד", "🙂 נהניתי", "😐 בסדר", "🙁 פחות"].map((t) => opt(t)) })],
];
const asPoll = (raw: unknown) => normPollDraft(raw) as Poll | null;
/** הסקר שבמקום i ברשימה, לתצוגה ולעריכה (סקר בלי מזהה מקבל מזהה לפי המקום, כדי שאפשר יהיה למצוא אותו שוב) */
const pollAt = (item: unknown, i: number) => asPoll(item && typeof item === "object" && !Array.isArray(item) && !(item as Poll).id ? { ...(item as object), id: `p${i}` } : item);
const indexOf = (list: unknown[], id: string) => list.findIndex((item, i) => pollAt(item, i)?.id === id);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const pct = (n: number, sum: number) => (sum ? Math.round((n / sum) * 100) : 0);

export function PollsSection({ data, mutate, onMessage }: { data: Catalog; mutate: Mutate; onMessage(message: string): void }) {
  const raw = data.settings.polls;
  // לתצוגה ולעריכה בלבד — מה שנשמר הוא הסקר המקורי, עד שעורכים אותו
  const polls = useMemo(() => (raw || []).flatMap((item, i) => { const poll = pollAt(item, i); return poll ? [poll] : []; }), [raw]);
  const episodeLabel = (id: string) => { const e = data.episodes.find((x) => x.id === id || x.slug === id); return e ? label(e) : "תוכנית שנמחקה"; };
  const [editing, setEditing] = useState<Editing | null>(null);
  // פתוח לעריכה עם שינויים שלא נשמרו: עדכון אוטומטי של האתר מחכה
  useHoldUpdate(!!editing?.dirty);
  const [results, setResults] = useState<Record<string, Result> | null>(null);
  const [resultsError, setResultsError] = useState("");
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState("");
  const ids = polls.map((p) => p.id).join(",");
  const now = israelWallClock();

  // התוצאות החיות: בכניסה, כל 30 שניות, ובלחיצה על „רענון”
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!ids) return;
      api<{ results: Record<string, Result> }>(`/api/program/polls/results?ids=${encodeURIComponent(ids)}`)
        .then((r) => { if (!active) return; setResults(r.results || {}); setResultsError(""); setLoadedAt(Date.now()); })
        .catch((error) => { if (active) setResultsError(errorText(error, "טעינת התוצאות נכשלה.")); });
    };
    refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [ids, tick]);

  const writePolls = (fn: (list: Poll[]) => Poll[]) => mutate((cur) => ({ ...cur, settings: { ...cur.settings, polls: fn(cur.settings.polls || []) } }));
  const leave = () => !editing?.dirty || confirm("יש שינויים בסקר הפתוח שלא נשמרו. לעזוב אותם?");
  const open = (poll: Poll | null, preset: Partial<Poll> = {}) => {
    if (!leave()) return;
    const draft = clone(poll || (blankPoll(preset) as Poll));
    while (draft.options.length < 2) draft.options.push(opt());
    setEditing({ draft, isNew: !poll, dirty: false });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const duplicate = (poll: Poll) => {
    if (editing?.draft.id !== poll.id && !leave()) return;
    const copy = { ...clone(poll), id: newPollId(12), enabled: false, createdAt: new Date().toISOString(), question: poll.question ? `${poll.question} (עותק)`.slice(0, POLL_LIMITS.question) : poll.question };
    setEditing({ draft: copy, isNew: true, dirty: true });
    onMessage("נוצר עותק (כבוי). שמרו כדי להוסיף אותו.");
  };
  const remove = (poll: Poll) => {
    if (!confirm(`למחוק את הסקר „${poll.question || poll.title || "בלי שאלה"}”? ההצבעות שכבר נאספו יישארו בשרת, אבל הסקר ייעלם מהאתר בפרסום הבא.`)) return;
    writePolls((list) => { const i = indexOf(list, poll.id); return i < 0 ? list : list.filter((_, j) => j !== i); });
    if (editing?.draft.id === poll.id) setEditing(null);
    onMessage("הסקר נמחק מהטיוטה. הפרסום יעדכן את האתר.");
  };
  const save = (draft: Poll) => {
    const clean = pollForSave(draft) as Poll;
    // רק הסקר שנערך מוחלף; כל השאר נשארים בדיוק כמו שהם
    writePolls((list) => { const i = indexOf(list, clean.id); return i < 0 ? [clean, ...list] : list.map((item, j) => (j === i ? clean : item)); });
    setEditing(null);
    onMessage(`הסקר נשמר בטיוטה. הוא ${clean.enabled ? "יעלה לאתר" : "יישמר (כבוי)"} בלחיצה על „פרסום התוכניות”.`);
  };
  const reset = async (poll: Poll) => {
    const total = results?.[poll.id]?.total || 0;
    if (!confirm(`לאפס את כל ההצבעות בסקר „${poll.question || poll.title}”? ${total === 1 ? "ההצבעה" : `${n2(total)} ההצבעות`} יימחקו מהשרת מיד — גם באתר — ואי אפשר לבטל.`)) return;
    setBusy(poll.id);
    try { await api("/api/program/polls/reset", { method: "POST", body: JSON.stringify({ pollId: poll.id }) }); onMessage("ההצבעות אופסו."); setTick((v) => v + 1); }
    catch (error) { onMessage(errorText(error, "האיפוס נכשל.")); }
    finally { setBusy(""); }
  };

  return <>
    {editing && <PollEditor key={editing.draft.id} editing={editing} episodes={data.episodes} result={results?.[editing.draft.id] || null} episodeLabel={episodeLabel} onChange={(update) => setEditing((cur) => (cur ? { ...cur, draft: update(cur.draft), dirty: true } : cur))} onSave={save} onDelete={remove}
      onDuplicate={duplicate} onClose={() => { if (!editing.dirty || confirm("יש שינויים שלא נשמרו. לסגור בלי לשמור?")) setEditing(null); }} />}

    <Section title="סקרים באתר" aside={<button type="button" className="prog-primary" data-tour="polls-new" onClick={() => open(null)}>+ סקר חדש</button>}>
      <p className="panel-help">שאלה למאזינים, עם תשובות (אפשר עם תמונה לכל תשובה). בוחרים איפה הסקר מופיע — בדף הבית, בארכיון, באזור האישי, בדף של תוכנית מסוימת או בכל דפי התוכניות — מתי הוא נפתח ונסגר, ומי רואה את התוצאות. מצביעים עם חשבון Google, כל מאזין פעם אחת.</p>
      <p className="prog-note">סקר חדש ושינוי בסקר נשמרים בטיוטה, כמו שאר ניהול התוכניות, ועולים לאתר רק ב„פרסום התוכניות” — כמו בניהול הישן, כי האתר קורא את הסקרים מהקטלוג המפורסם. ההצבעות, התוצאות והאיפוס — חיים, ישר מהשרת.</p>
      <div data-tour="polls-list">
        {polls.length ? <div className="pp-list">{polls.map((p) => {
          const st = pollState(p, now), where = pollPlaces(p, episodeLabel), r = results?.[p.id];
          return <div key={p.id} className={`pp-row${editing?.draft.id === p.id ? " editing" : ""}`}>
            <Thumb poll={p} />
            <div className="pp-main">
              <b>{p.question || p.title || "סקר בלי שאלה"}</b>
              <div className="pp-meta"><span className={`pp-state ${st.cls}`}>{st.text}</span>{where.length > 0 && <span>{where.join(" · ")}</span>}<span>{filledOptions(p).length} תשובות{p.multi ? ` · עד ${p.maxChoices} בחירות` : ""}</span><span>{RESULTS.find(([v]) => v === p.results)?.[1]}</span></div>
              <ResultBars poll={p} result={r} loaded={!!results} />
            </div>
            <div className="pp-ops">
              <button type="button" className="prog-btn" onClick={() => open(p)}>עריכה</button>
              <button type="button" className="prog-btn" onClick={() => duplicate(p)}>שכפול</button>
              {!!r?.total && <button type="button" className="prog-btn" disabled={busy === p.id} onClick={() => void reset(p)}>{busy === p.id ? "מאפסים…" : "איפוס הצבעות"}</button>}
              <button type="button" className="danger" onClick={() => remove(p)} aria-label="מחיקת הסקר">✕</button>
            </div>
          </div>;
        })}</div> : <div className="prog-empty"><b aria-hidden="true">?</b><h3>עדיין אין סקרים</h3><p className="panel-help">שאלה אחת, כמה תשובות — והמאזינים מצביעים ישר מהאתר.</p><button type="button" className="prog-primary" onClick={() => open(null)}>יצירת הסקר הראשון ←</button></div>}
      </div>
      <div className="row-actions" data-tour="polls-results">
        <button type="button" className="prog-btn" disabled={!polls.length} onClick={() => setTick((v) => v + 1)}>↻ רענון התוצאות</button>
        <small className="panel-help">{resultsError ? "" : loadedAt ? `התוצאות מתעדכנות לבד כל 30 שניות · עודכנו ב־${new Intl.DateTimeFormat("he-IL", { timeStyle: "short" }).format(loadedAt)}` : polls.length ? "טוענים את התוצאות…" : ""}</small>
        <Status error={resultsError} />
      </div>
    </Section>
  </>;
}

function Thumb({ poll }: { poll: Poll }) {
  const img = poll.image || poll.options.find((o) => o.image)?.image;
  return <span className="pp-thumb" style={{ "--pp-h": poll.hue } as CSSProperties}>{img ? <img src={img} alt="" loading="lazy" /> : <i aria-hidden="true">?</i>}</span>;
}

/** התוצאות החיות של סקר: כמה הצביעו, וכמה קיבלה כל תשובה */
function ResultBars({ poll, result, loaded }: { poll: Poll; result?: Result; loaded: boolean }) {
  if (!loaded) return null;
  if (!result || (!result.published && !result.total)) return <small className="panel-help">עוד לא באתר — אחרי הפרסום יופיעו כאן ההצבעות.</small>;
  if (!result.total) return <small className="panel-help">עוד אין הצבעות.</small>;
  const options: PollOption[] = filledOptions(poll);
  const known = new Set(options.map((o) => o.id));
  const sum = options.reduce((a, o) => a + (result.counts[o.id] || 0), 0);
  const top = Math.max(0, ...options.map((o) => result.counts[o.id] || 0));
  const gone = Object.entries(result.counts).filter(([id]) => !known.has(id)).reduce((a, [, n]) => a + n, 0);
  return <div className="pp-results">
    <small className="pp-total">{result.total === 1 ? "מאזין אחד הצביע" : `${n2(result.total)} מאזינים הצביעו`}{result.lastVoteAt ? ` · ההצבעה האחרונה ${when(result.lastVoteAt)}` : ""}</small>
    {options.map((o) => { const n = result.counts[o.id] || 0; return <div key={o.id} className={`pp-bar${top && n === top ? " win" : ""}`} style={{ "--pct": `${pct(n, sum)}%`, "--pp-h": poll.hue } as CSSProperties}><i aria-hidden="true" /><em>{o.label}{o.sub ? ` · ${o.sub}` : ""}</em><b>{n2(n)} · {pct(n, sum)}%</b></div>; })}
    {gone > 0 && <small className="panel-help">{n2(gone)} הצבעות לתשובות שנמחקו מהסקר (לא נספרות באתר).</small>}
  </div>;
}

/* ---------- עורך סקר ---------- */

function Group({ n, title, children, tour }: { n: number; title: string; children: ReactNode; tour?: string }) {
  return <fieldset className="pp-group" data-tour={tour}><legend><i>{n}</i>{title}</legend>{children}</fieldset>;
}
function Seg<T extends string>({ value, list, onPick, label: aria }: { value: T; list: Array<[T, string]>; onPick(value: T): void; label: string }) {
  return <div className="prog-segmented" role="group" aria-label={aria}>{list.map(([v, t]) => <button key={v} type="button" className="prog-btn" aria-pressed={value === v} onClick={() => onPick(v)}>{t}</button>)}</div>;
}

function PollEditor({ editing, episodes, result, episodeLabel, onChange, onSave, onDelete, onDuplicate, onClose }: {
  editing: Editing; episodes: Episode[]; result: Result | null; episodeLabel(id: string): string;
  onChange(update: (draft: Poll) => Poll): void; onSave(draft: Poll): void; onDelete(poll: Poll): void; onDuplicate(poll: Poll): void; onClose(): void;
}) {
  const p = editing.draft;
  const [upload, setUpload] = useState<{ target: string; pct: number } | null>(null);
  const [error, setError] = useState("");
  const [epQuery, setEpQuery] = useState("");
  const [bulk, setBulk] = useState("");
  // כל שינוי מחושב מהסקר העדכני — גם העלאה שמסתיימת אחרי שהמשכתם לכתוב לא דורסת את מה שנכתב
  const set = (fields: Partial<Poll>) => onChange((d) => ({ ...d, ...fields }));
  const setShow = (fields: Partial<Poll["show"]>) => onChange((d) => ({ ...d, show: { ...d.show, ...fields } }));
  const withOptions = (d: Poll, options: PollOption[]): Poll => {
    const list = [...options]; while (list.length < 2) list.push(opt());
    const count = list.filter((o) => o.label.trim()).length;
    return { ...d, options: list, maxChoices: d.multi ? Math.max(1, Math.min(d.maxChoices, count || 1)) : d.maxChoices };
  };
  const setOptions = (options: PollOption[]) => onChange((d) => withOptions(d, options));
  const setOptionById = (id: string, fields: Partial<PollOption>) => onChange((d) => withOptions(d, d.options.map((o) => (o.id === id ? { ...o, ...fields } : o))));
  const setOption = (i: number, fields: Partial<PollOption>) => setOptionById(p.options[i].id, fields);
  const move = (i: number, to: number) => { if (to < 0 || to >= p.options.length) return; const next = [...p.options]; [next[i], next[to]] = [next[to], next[i]]; setOptions(next); };
  const problems = pollProblems(p), where = pollPlaces(p, episodeLabel), filled = filledOptions(p).length;
  const now = israelWallClock();
  const sorted = useMemo(() => [...episodes].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || 0) - (a.number || 0)), [episodes]);
  const chosen = new Set(p.show.episodes);
  const q = epQuery.trim().toLowerCase();
  const rest = sorted.filter((e) => !chosen.has(e.id) && !chosen.has(e.slug));
  const found = q ? rest.filter((e) => [e.title, e.description, e.date, e.number == null ? "" : String(e.number), ...e.guests].join(" ").toLowerCase().includes(q)) : rest;
  const guestNames = [...new Set(episodes.filter((e) => chosen.has(e.id) || chosen.has(e.slug)).flatMap((e) => e.guests))].filter((g) => !p.options.some((o) => o.label.trim() === g));
  const votedOn = new Set(Object.keys(result?.counts || {}).filter((id) => result?.counts[id]));

  /** target — "poll" לתמונת הסקר, או המזהה של התשובה (לא המקום, כי הסדר יכול להשתנות בזמן ההעלאה) */
  const pickImage = async (event: ChangeEvent<HTMLInputElement>, target: string) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) { setError("אפשר להעלות JPG, PNG או WEBP."); return; }
    setError(""); setUpload({ target: String(target), pct: 0 });
    try {
      const url = await uploadFile(await shrinkImage(file), `poll-${p.id}`, "cover", (n) => setUpload({ target: String(target), pct: n }));
      if (target === "poll") set({ image: url }); else setOptionById(target, { image: url });
    } catch (cause) { setError(`ההעלאה נכשלה: ${errorText(cause, "")}`); }
    finally { setUpload(null); }
  };
  const uploading = (target: string) => (upload?.target === target ? `מעלים… ${upload.pct}%` : "");
  const save = () => {
    if (p.enabled && problems.length && !confirm(`${problems.join(", ")}.\nהסקר יישמר, אבל לא יוצג באתר עד שזה יתוקן. לשמור?`)) return;
    onSave(p);
  };
  const addBulk = () => {
    const lines = bulk.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const add = lines.map((l) => { const [a, ...more] = l.split(/\s+[—–-]\s+/); return opt(a.slice(0, POLL_LIMITS.label), more.join(" — ").slice(0, POLL_LIMITS.sub)); });
    setOptions(p.options.filter((o) => o.label.trim() || o.image).concat(add).slice(0, POLL_LIMITS.options));
    setBulk("");
  };

  return <Section id="tour-poll-editor" title={editing.isNew ? "סקר חדש" : `עריכת סקר: ${p.question || p.title || "בלי שאלה"}`} aside={<button type="button" className="prog-btn" onClick={onClose}>סגירה ✕</button>}>
    {editing.isNew && !p.question && !filled && <div className="prog-field"><span>להתחיל מתבנית?</span><div className="prog-chips">{TEMPLATES.map(([t, make]) => <button key={t} type="button" className="prog-chip" onClick={() => set(make())}>{t}</button>)}</div></div>}

    <Group n={1} title="השאלה">
      <div className="prog-form">
        <label className="wide"><span>השאלה</span><input value={p.question} maxLength={POLL_LIMITS.question} placeholder="למשל: איזה שיר הכי אהבתם בתוכנית?" onChange={(e) => set({ question: e.target.value })} /></label>
        <label><span>כותרת קטנה מעל (לא חובה)</span><input value={p.title} maxLength={POLL_LIMITS.title} placeholder="למשל: השיר של השבוע" onChange={(e) => set({ title: e.target.value })} /></label>
        <label><span>טקסט הכפתור</span><input value={p.buttonLabel} maxLength={POLL_LIMITS.buttonLabel} placeholder="הצבעה" onChange={(e) => set({ buttonLabel: e.target.value })} /></label>
        <label className="wide"><span>הסבר (לא חובה)</span><textarea value={p.description} maxLength={POLL_LIMITS.description} rows={2} placeholder="למשל: התוצאות יוקראו בתוכנית הבאה." onChange={(e) => set({ description: e.target.value })} /></label>
        <div className="prog-field"><span>תמונה לסקר (לא חובה)</span>
          <div className="pp-image">{p.image ? <img src={p.image} alt="" /> : <i aria-hidden="true">🖼️</i>}
            <div className="row-actions"><FilePick accept=".jpg,.jpeg,.png,.webp" disabled={!!upload} onChange={(e) => void pickImage(e, "poll")}>{uploading("poll") || (p.image ? "⬆ החלפה" : "⬆ העלאת תמונה")}</FilePick>{p.image && <button type="button" className="danger" onClick={() => set({ image: "" })}>הסרה</button>}</div>
          </div>
        </div>
        <div className="prog-field"><span>צורת התמונה</span><Seg label="צורת התמונה" value={p.imageShape} onPick={(imageShape) => set({ imageShape })} list={[["wide", "רחבה, מעל"], ["square", "ריבוע ליד השאלה"], ["circle", "עיגול ליד השאלה"]]} />
          <input dir="ltr" value={p.image} placeholder="או קישור לתמונה: https://…" aria-label="קישור לתמונה" onChange={(e) => set({ image: e.target.value.trim() })} /></div>
      </div>
    </Group>

    <Group n={2} title={`התשובות · ${filled} מתוך ${POLL_LIMITS.options}`}>
      <p className="panel-help">לכל תשובה אפשר להוסיף שורה שנייה (למשל שם הזמר) ותמונה (תמונת אמן או עטיפת אלבום).{votedOn.size ? " לתשובה שכבר הצביעו לה כדאי לשנות רק כתיב — מחיקה שלה מוחקת גם את הספירה שלה באתר." : ""}</p>
      <div className="pp-opts">{p.options.map((o, i) => <div key={o.id} className="pp-opt">
        <span className="pp-opt-img">{o.image ? <img src={o.image} alt="" /> : <i aria-hidden="true">{i + 1}</i>}</span>
        <div className="pp-opt-text">
          <input value={o.label} maxLength={POLL_LIMITS.label} placeholder={`תשובה ${i + 1}`} aria-label={`תשובה ${i + 1}`} onChange={(e) => setOption(i, { label: e.target.value })} />
          <input value={o.sub} maxLength={POLL_LIMITS.sub} placeholder="שורה שנייה (לא חובה) — למשל הזמר" aria-label={`שורה שנייה לתשובה ${i + 1}`} onChange={(e) => setOption(i, { sub: e.target.value })} />
          {votedOn.has(o.id) && <small className="panel-help">{n2(result?.counts[o.id] || 0)} הצבעות</small>}
        </div>
        <div className="pp-opt-ops">
          <FilePick accept=".jpg,.jpeg,.png,.webp" disabled={!!upload} onChange={(e) => void pickImage(e, o.id)}>{uploading(o.id) || (o.image ? "🖼️ החלפה" : "🖼️ תמונה")}</FilePick>
          {o.image && <button type="button" className="prog-btn" onClick={() => setOption(i, { image: "" })} aria-label="הסרת התמונה של התשובה">בלי תמונה</button>}
          <button type="button" className="prog-btn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="למעלה">↑</button>
          <button type="button" className="prog-btn" disabled={i === p.options.length - 1} onClick={() => move(i, i + 1)} aria-label="למטה">↓</button>
          <button type="button" className="danger" onClick={() => { if (votedOn.has(o.id) && !confirm(`לתשובה „${o.label}” כבר יש הצבעות. למחוק אותה?`)) return; setOptions(p.options.filter((_, j) => j !== i)); }} aria-label={`מחיקת תשובה ${i + 1}`}>✕</button>
        </div>
      </div>)}</div>
      <div className="row-actions">
        <button type="button" className="prog-btn" disabled={p.options.length >= POLL_LIMITS.options} onClick={() => setOptions([...p.options, opt()])}>+ תשובה</button>
        {guestNames.length > 0 && <button type="button" className="prog-btn" onClick={() => setOptions(p.options.filter((o) => o.label.trim() || o.image).concat(guestNames.map((g) => opt(g))).slice(0, POLL_LIMITS.options))}>+ מהאורחים של התוכנית ({guestNames.length})</button>}
      </div>
      <details className="pp-bulk"><summary>הוספת הרבה תשובות בבת אחת</summary>
        <textarea value={bulk} rows={4} placeholder={"שורה לכל תשובה. שורה שנייה אחרי מקף:\nאנא בכח — מוטי שטיינמץ\nימים — ישי ריבו"} onChange={(e) => setBulk(e.target.value)} />
        <button type="button" className="prog-btn" onClick={addBulk}>הוספה</button>
      </details>
    </Group>

    <Group n={3} title="עיצוב">
      <div className="prog-form">
        <div className="prog-field"><span>איך התשובות מסודרות</span><Seg label="סידור התשובות" value={p.layout} onPick={(layout) => set({ layout })} list={[["list", "רשימה"], ["grid", "רשת"], ["cards", "כרטיסים"]]} /></div>
        <div className="prog-field"><span>צורת התמונות של התשובות</span><Seg label="צורת התמונות" value={p.optionShape} onPick={(optionShape) => set({ optionShape })} list={[["circle", "עיגול"], ["rounded", "ריבוע מעוגל"], ["square", "ריבוע"]]} /></div>
        <div className="prog-field"><span>גודל</span><Seg label="גודל" value={p.optionSize} onPick={(optionSize) => set({ optionSize })} list={[["s", "קטן"], ["m", "בינוני"], ["l", "גדול"]]} /></div>
        <div className="prog-field"><span>צבע</span>
          <div className="pp-hues">{HUES.map((h) => <button key={h} type="button" className="pp-hue" style={{ "--h": h } as CSSProperties} aria-pressed={p.hue === h} aria-label={`גוון ${h}`} onClick={() => set({ hue: h })} />)}
            <input type="range" min={0} max={359} value={p.hue} aria-label="גוון מדויק" onChange={(e) => set({ hue: Number(e.target.value) })} /></div>
        </div>
      </div>
    </Group>

    <Group n={4} title="ההצבעה ומי רואה תוצאות">
      <div className="prog-form">
        <div className="prog-field"><span>כמה אפשר לבחור</span><Seg label="כמה אפשר לבחור" value={p.multi ? "multi" : "one"} onPick={(v) => set(v === "multi" ? { multi: true, maxChoices: Math.min(Math.max(2, p.maxChoices || 2), Math.max(1, filled)) } : { multi: false })} list={[["one", "תשובה אחת"], ["multi", "כמה תשובות"]]} /></div>
        {p.multi && <label><span>עד כמה בחירות</span><input type="number" dir="ltr" min={1} max={Math.max(1, filled)} value={p.maxChoices} onChange={(e) => set({ maxChoices: Math.max(1, Math.min(filled || 1, Number(e.target.value) || 1)) })} /></label>}
        <div className="prog-field wide"><span>מתי המאזינים רואים את התוצאות</span>
          <div className="pp-radios">{RESULTS.map(([v, t, sub]) => <label key={v} className={`pp-radio${p.results === v ? " on" : ""}`}><input type="radio" name={`pp-results-${p.id}`} checked={p.results === v} onChange={() => set({ results: v })} /><b>{t}</b><small>{sub}</small></label>)}</div>
        </div>
        <div className="prog-switches wide"><Switch on={p.allowChange} onClick={() => set({ allowChange: !p.allowChange })}>{p.allowChange ? "אפשר לשנות הצבעה" : "הצבעה סופית — בלי שינוי"}</Switch></div>
        <label className="wide"><span>הודעה אחרי ההצבעה</span><input value={p.thanks} maxLength={POLL_LIMITS.thanks} placeholder="ההצבעה שלכם נקלטה. תודה!" onChange={(e) => set({ thanks: e.target.value })} /></label>
      </div>
    </Group>

    <Group n={5} title="איפה ומתי">
      <div className="prog-switches"><Switch on={p.enabled} onClick={() => set({ enabled: !p.enabled })}>{p.enabled ? "פעיל — יוצג באתר אחרי הפרסום" : "כבוי — שמור רק כאן"}</Switch></div>
      <div className="prog-field"><span>איפה להציג</span>
        <div className="pp-places">{PLACES.map(([k, t]) => <label key={k} className="prog-check"><input type="checkbox" checked={p.show[k]} onChange={(e) => setShow({ [k]: e.target.checked } as Partial<Poll["show"]>)} /> {t}</label>)}</div>
      </div>
      {!p.show.allEpisodes && <div className="prog-field"><span>בדף של תוכניות מסוימות ({p.show.episodes.length} נבחרו) — מוצג בולט מתחת לפתיחה</span>
        <input className="prog-search" type="search" placeholder="חיפוש תוכנית…" value={epQuery} onChange={(e) => setEpQuery(e.target.value)} aria-label="חיפוש תוכנית" />
        <div className="pp-eps">
          {p.show.episodes.map((id) => <label key={id} className="prog-check pp-ep on"><input type="checkbox" checked onChange={() => setShow({ episodes: p.show.episodes.filter((x) => x !== id) })} /> <b>{episodeLabel(id)}</b></label>)}
          {found.slice(0, q ? 40 : 12).map((e) => <label key={e.id} className="prog-check pp-ep"><input type="checkbox" checked={false} onChange={() => setShow({ episodes: [...p.show.episodes, e.id] })} /> <b>{label(e)}</b><small>{[e.number != null ? `תוכנית ${e.number}` : "", e.date ? fmtDate(e.date) : ""].filter(Boolean).join(" · ")}</small></label>)}
          {!q && rest.length > 12 && <small className="panel-help">ועוד {rest.length - 12} — חפשו כדי למצוא.</small>}
          {q && !found.length && <small className="panel-help">לא נמצאו תוכניות.</small>}
        </div>
      </div>}
      <div className="prog-form">
        <label><span>נפתח ב־ (שעון ישראל, לא חובה)</span><input type="datetime-local" value={p.from} onChange={(e) => set({ from: e.target.value.slice(0, 16) })} /><small>{p.from ? (p.from > now ? "עד אז הסקר לא מוצג באתר." : "המועד עבר — הסקר פתוח.") : "ריק — מיד אחרי הפרסום."}</small></label>
        <label><span>נסגר ב־ (שעון ישראל, לא חובה)</span><input type="datetime-local" value={p.until} onChange={(e) => set({ until: e.target.value.slice(0, 16) })} /><small>אחרי זה אי אפשר להצביע, והתוצאות נשארות (לפי „מי רואה תוצאות”).</small></label>
      </div>
      <div className="prog-chips">{([[1, "נסגר בעוד יום"], [3, "בעוד 3 ימים"], [7, "בעוד שבוע"], [14, "בעוד שבועיים"], [0, "בלי מועד סגירה"]] as Array<[number, string]>).map(([d, t]) => <button key={d} type="button" className="prog-chip" onClick={() => set({ until: d ? untilIn(d, p.from, now) : "" })}>{t}</button>)}</div>
    </Group>

    <div className="pp-foot">
      <span className={`pp-issues${problems.length || (p.enabled && !where.length) ? " bad" : ""}`} aria-live="polite">{problems.length ? `⚠ ${problems.join(" · ")}` : !p.enabled ? "הסקר כבוי — יישמר, אבל לא יוצג באתר." : where.length ? `יוצג ב: ${where.join(" · ")}` : "⚠ לא נבחר איפה להציג"}</span>
      <Status error={error} />
      <div className="row-actions">
        {!editing.isNew && <><button type="button" className="danger" onClick={() => onDelete(p)}>מחיקה</button><button type="button" className="prog-btn" onClick={() => onDuplicate(p)}>שכפול</button></>}
        <button type="button" className="prog-btn" onClick={onClose}>ביטול</button>
        <button type="button" className="prog-primary" disabled={!!upload} onClick={save}>{editing.isNew ? "יצירת הסקר" : "שמירה בטיוטה"} ←</button>
      </div>
    </div>
  </Section>;
}
