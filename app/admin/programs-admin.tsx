"use client";

/* ניהול אתר התוכניות — חלק רגיל של דף הניהול, באותו עיצוב ובאותה כניסה.
   הכול עובד על טיוטה שנשמרת אוטומטית בשרת (/api/program/draft), ו"פרסום"
   מעביר אותה לאתר התוכניות (/api/program/catalog). ארבעה חלקים: תוכניות,
   הודעה ועדכונים, מאזינים, פרסום. הטיפוסים והעזרים ב־programs-core, הבינה
   המלאכותית ב־programs-ai, המאזינים ב־programs-listeners, העבודות ב־programs-jobs. */

import type { ChangeEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./programs-admin.css";
import {
  api, drainPush, drawCover, driveId, errorText, fileKind, fmtDate, fmtDuration, hasRealDescription, label, makeThumb, measureDuration, n2, normCatalog, normEpisode, pack,
  PROGRAM_SITE, scheduled, setCover, shrinkImage, slugify, splitList, streamUrl, today, uploadFile, when,
  type ApiError, type Banner, type Catalog, type Comment, type Contacts, type Episode, type Message, type Season, type Stats, type SurveyRow, type Update, type Version,
} from "./programs-core";
import { FilePick, Section, Status, Switch } from "./programs-ui";
import { AiCard, aiRun, ProofreadCard, summaryPatch } from "./programs-ai";
import { CommentsCard, commentsError, CountSettings, DeepStats, EpisodeTable, minutesText, PushCard } from "./programs-listeners";
import { runJob, stopJob, useJob } from "./programs-jobs";

export type ProgramSection = "programs" | "site" | "listeners" | "publish";
type Mutate = (fn: (current: Catalog) => Catalog) => void;
type PatchEpisode = (id: string, fields: Partial<Episode> | ((episode: Episode) => Partial<Episode>)) => void;
type Common = { data: Catalog; change(next: Catalog): void; mutate: Mutate; patchEpisode: PatchEpisode; onMessage(message: string): void };

/** עורך טיוטת המייל באתר התוכניות (mail.html): נפתח בלשונית חדשה כבר מחוברים — קוד מעבר חד־פעמי,
    כמו המעבר לניהול. הלשונית נפתחת מיד בלחיצה (אחרת הדפדפן חוסם אותה), והכתובת נקבעת אחרי שהקוד מגיע. */
function openMailDraft(id: string, onMessage: (message: string) => void) {
  const target = `${PROGRAM_SITE}mail.html?ep=${encodeURIComponent(id)}`;
  const tab = window.open("", "_blank");
  if (!tab) { onMessage("הדפדפן חסם את הלשונית החדשה. אפשרו חלונות קופצים ונסו שוב."); return; }
  tab.opener = null;
  api<{ code: string }>("/api/program/handoff", { method: "POST", body: "{}" })
    .then(({ code }) => { tab.location.href = `${target}&handoff=${encodeURIComponent(code)}`; })
    .catch(() => { tab.location.href = target; });
}

/* ---------- הרכיב ---------- */

export function ProgramsAdmin({ section, onMessage }: { section: ProgramSection | null; onMessage(message: string): void }) {
  const [origin, setOrigin] = useState<Catalog | null>(null);
  const [data, setData] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState("");
  const [sync, setSync] = useState<"" | "saving" | "saved" | "error">("");
  const [surveys, setSurveys] = useState<SurveyRow[]>([]);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataRef = useRef<Catalog | null>(null);
  // הגרסה שבאתר כשהתחילו לערוך — נשלחת בפרסום (baseVersion) כהגנה מדריסה בין מנהלים
  const base = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api<Record<string, unknown> & { versionId?: string | null }>("/api/program/catalog"), api<{ draft: { data: Record<string, unknown> & { baseVersion?: string | null } } | null }>("/api/program/draft").catch(() => ({ draft: null })), api<{ surveys: SurveyRow[] }>("/api/program/surveys").catch(() => ({ surveys: [] }))])
      .then(([published, { draft }, list]) => {
        if (!active) return;
        const pub = normCatalog(published);
        base.current = draft?.data && draft.data.baseVersion !== undefined ? draft.data.baseVersion ?? null : published.versionId ?? null;
        const next = draft?.data ? normCatalog(draft.data) : pub;
        dataRef.current = next;
        setOrigin(pub); setData(next); setSurveys(list.surveys || []); setLoadError("");
      })
      .catch((error) => { if (active) setLoadError(errorText(error, "טעינת אתר התוכניות נכשלה.")); });
    return () => { active = false; };
  }, [reload]);

  /** כל שינוי נשמר אוטומטית בטיוטה בשרת. השינוי מחושב מהמצב העדכני ביותר, כך שגם עבודות ברקע לא דורסות עריכה */
  const mutate = useCallback<Mutate>((fn) => {
    const current = dataRef.current; if (!current) return;
    const next = fn(current); if (next === current) return;
    dataRef.current = next; setData(next); setSync("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api("/api/program/draft", { method: "PUT", body: JSON.stringify({ data: { ...next, baseVersion: base.current } }) }).then(() => setSync("saved")).catch(() => setSync("error"));
    }, 900);
  }, []);
  const change = useCallback((next: Catalog) => mutate(() => next), [mutate]);
  const patchEpisode = useCallback<PatchEpisode>((id, fields) => mutate((current) => ({ ...current, episodes: current.episodes.map((e) => (e.id === id ? { ...e, ...(typeof fields === "function" ? fields(e) : fields) } : e)) })), [mutate]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const changes = useMemo(() => {
    if (!origin || !data) return null;
    const before = new Map(origin.episodes.map((e) => [e.id, pack(e)]));
    let added = 0, changed = 0;
    for (const episode of data.episodes) { if (!before.has(episode.id)) added++; else if (before.get(episode.id) !== pack(episode)) changed++; }
    const removed = origin.episodes.filter((e) => !data.episodes.some((x) => x.id === e.id));
    const seasons = JSON.stringify(origin.seasons) !== JSON.stringify(data.seasons);
    const settings = JSON.stringify(origin.settings) !== JSON.stringify(data.settings);
    return { added, changed, removed, seasons, settings, any: !!(added || changed || removed.length || seasons || settings) };
  }, [origin, data]);

  /** פתיחת תוכנית מחלק אחר (למשל מבדיקת האיות): בוחרים אותה ועוברים ללשונית התוכניות */
  const open = useCallback((id: string | null) => { if (id) setSelected(id); window.location.hash = id ? "#prog-programs" : "#prog-site"; }, []);

  if (!section) return null;
  if (loadError) return <section className="admin-panel"><h2>אתר התוכניות</h2><p className="panel-help">{loadError}</p><button type="button" className="prog-btn" onClick={() => { setLoadError(""); setReload((v) => v + 1); }}>ניסיון חוזר</button></section>;
  if (!data || !origin) return <section className="admin-panel"><p className="panel-help">טוענים את אתר התוכניות…</p></section>;

  const status = !changes?.any ? { cls: "ok", text: "הכול מפורסם באתר התוכניות" } : { cls: "draft", text: `יש שינויים שעדיין לא פורסמו · ${sync === "saving" ? "שומרים…" : sync === "error" ? "השמירה נכשלה, ננסה שוב בשינוי הבא" : "נשמרו בטיוטה"}` };
  const statusBar = <div className={`prog-status ${status.cls}`}><span className="dot" />{status.text}{changes?.any && section !== "publish" && <a href="#prog-publish" className="prog-status-link">לפרסום ←</a>}</div>;
  const common: Common = { data, change, mutate, patchEpisode, onMessage };
  return <div className="prog-admin">
    {statusBar}
    {section === "programs" && <ProgramsSection {...common} surveys={surveys} selected={selected} onSelect={setSelected} live={new Set(origin.episodes.filter((e) => e.visible).map((e) => e.id))} />}
    {section === "site" && <SiteSection {...common} />}
    {section === "listeners" && <ListenersSection data={data} onMessage={onMessage} />}
    {section === "publish" && <PublishSection {...common} origin={origin} changes={changes} base={base} onOpen={open} onPublished={(published, versionId) => { base.current = versionId; dataRef.current = published; setOrigin(published); setData(published); setSync(""); }} onDiscard={() => setReload((v) => v + 1)} />}
  </div>;
}

/* ======================= 1. תוכניות ======================= */

function ProgramsSection({ data, change, patchEpisode, onMessage, surveys, live, selected, onSelect }: Common & { surveys: SurveyRow[]; live: Set<string>; selected: string | null; onSelect(id: string | null): void }) {
  const [query, setQuery] = useState(""), [filter, setFilter] = useState("all");
  const [bulk, setBulk] = useState(false), [picked, setPicked] = useState<Set<string>>(new Set());
  const sorted = useMemo(() => data.episodes.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.number || 0) - (a.number || 0)), [data.episodes]);
  const shown = sorted.filter((e) => {
    if (filter === "visible" && !(e.visible && !scheduled(e))) return false;
    if (filter === "hidden" && e.visible) return false;
    if (filter === "scheduled" && !scheduled(e)) return false;
    if (filter === "noaudio" && streamUrl(e)) return false;
    if (filter === "nocover" && e.cover) return false;
    const q = query.trim().toLowerCase();
    return !q || [e.title, e.description, e.number, e.date, ...e.guests, ...e.tags].join(" ").toLowerCase().includes(q);
  });
  const current = data.episodes.find((e) => e.id === selected) || null;
  const setEpisodes = (episodes: Episode[]) => change({ ...data, episodes });
  const uniqueSlug = (base: string, self: string) => { const root = slugify(base); let slug = root, n = 2; while (data.episodes.some((e) => e.slug === slug && e.id !== self)) slug = `${root}-${n++}`; return slug; };

  const create = () => {
    const id = `ep-${Date.now().toString(36)}`, number = data.episodes.reduce((m, e) => Math.max(m, e.number || 0), 0) + 1;
    const episode = normEpisode({ id, slug: uniqueSlug(today(), id), number, season: data.seasons[0]?.id || "", date: today(), visible: true }, 0);
    setEpisodes([episode, ...data.episodes]); setQuery(""); setFilter("all"); setBulk(false); onSelect(id);
  };
  const duplicate = (episode: Episode) => {
    const id = `ep-${Date.now().toString(36)}`;
    setEpisodes([{ ...episode, id, slug: uniqueSlug(`${episode.slug}-2`, id), number: episode.number != null ? episode.number + 1 : null, featured: false, title: `${episode.title} (עותק)` }, ...data.episodes]);
    onSelect(id); onMessage("התוכנית שוכפלה. זה העותק — ערכו אותו.");
  };
  const removeIds = (ids: string[]) => { setEpisodes(data.episodes.filter((e) => !ids.includes(e.id))); if (selected && ids.includes(selected)) onSelect(null); setPicked(new Set()); onMessage(ids.length === 1 ? "התוכנית נמחקה מהטיוטה. עד הפרסום היא עדיין באתר." : `${ids.length} תוכניות נמחקו מהטיוטה.`); };
  const bulkSet = (fields: Partial<Episode>, message: string) => { setEpisodes(data.episodes.map((e) => (picked.has(e.id) ? { ...e, ...fields } : e))); onMessage(message); };

  return <div className="prog-workspace">
    <aside className="admin-panel prog-list">
      <button type="button" className="prog-primary" onClick={create}>+ תוכנית חדשה</button>
      <input className="prog-search" type="search" placeholder="חיפוש תוכנית…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="חיפוש תוכנית" />
      <div className="prog-filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="סינון"><option value="all">כל התוכניות</option><option value="visible">מוצגות באתר</option><option value="hidden">מוסתרות</option><option value="scheduled">מתוזמנות</option><option value="noaudio">בלי הקלטה</option><option value="nocover">בלי תמונה</option></select>
        <small>{shown.length === data.episodes.length ? `${shown.length} תוכניות` : `${shown.length} מתוך ${data.episodes.length}`}</small>
        <Switch on={bulk} onClick={() => { setBulk(!bulk); setPicked(new Set()); }}>בחירה מרובה</Switch>
      </div>
      {bulk && <div className="prog-bulk">
        <small>{picked.size ? `נבחרו ${picked.size}` : "לחצו על תוכניות כדי לבחור"}</small>
        <button type="button" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.map((e) => e.id)))}>{picked.size === shown.length && picked.size ? "ניקוי" : "בחירת כל המוצגות"}</button>
        {!!picked.size && <>
          <button type="button" onClick={() => bulkSet({ visible: true }, `${picked.size} תוכניות יוצגו באתר.`)}>הצגה</button>
          <button type="button" onClick={() => bulkSet({ visible: false }, `${picked.size} תוכניות הוסתרו.`)}>הסתרה</button>
          <select value="" onChange={(e) => { if (e.target.value) bulkSet({ season: e.target.value === "__none" ? "" : e.target.value }, `${picked.size} תוכניות שויכו לעונה.`); }} aria-label="שיוך לעונה"><option value="">שיוך לעונה…</option>{data.seasons.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}<option value="__none">בלי עונה</option></select>
          <button type="button" className="danger" onClick={() => { if (confirm(`למחוק ${picked.size} תוכניות?`)) removeIds([...picked]); }}>מחיקה</button>
        </>}
      </div>}
      <div className="prog-items" role="listbox" aria-label="תוכניות">
        {shown.map((e) => {
          const on = bulk ? picked.has(e.id) : selected === e.id;
          return <button key={e.id} type="button" role="option" aria-selected={on} className={`prog-item${on ? " selected" : ""}${e.visible ? "" : " muted"}`} onClick={() => { if (bulk) { const next = new Set(picked); if (next.has(e.id)) next.delete(e.id); else next.add(e.id); setPicked(next); } else onSelect(e.id); }}>
            <i>{bulk ? (picked.has(e.id) ? "✓" : "") : e.number ?? "♫"}</i>
            <span><b>{label(e)}</b><small>{fmtDate(e.date) || "בלי תאריך"} · <em className={!e.visible ? "st-hidden" : scheduled(e) ? "st-scheduled" : "st-live"}>{!e.visible ? "מוסתרת" : scheduled(e) ? "מתוזמנת" : "מוצגת"}</em>{e.featured ? " · ★" : ""}{streamUrl(e) ? "" : " · בלי הקלטה"}</small></span>
          </button>;
        })}
        {!shown.length && <p className="panel-help">אין תוכניות שמתאימות לחיפוש.</p>}
      </div>
    </aside>
    <div className="prog-editor">
      {current ? <Editor key={current.id} episode={current} live={live.has(current.id)} data={data} surveys={surveys} onPatch={(fields) => patchEpisode(current.id, fields)} onFeatured={(on) => setEpisodes(data.episodes.map((e) => ({ ...e, featured: on && e.id === current.id })))} onDuplicate={() => duplicate(current)} onDelete={() => { if (confirm(`למחוק את "${label(current)}"?`)) removeIds([current.id]); }} onSeasons={(seasons) => change({ ...data, seasons })} uniqueSlug={uniqueSlug} onMessage={onMessage} />
        : <section className="admin-panel prog-empty"><b>♫</b><h2>בחרו תוכנית מהרשימה</h2><p className="panel-help">או לחצו „+ תוכנית חדשה”. כל שינוי נשמר מיד; כשמסיימים לוחצים „פרסום התוכניות” בתפריט.</p></section>}
    </div>
  </div>;
}

function Editor({ episode, live, data, surveys, onPatch, onFeatured, onDuplicate, onDelete, onSeasons, uniqueSlug, onMessage }: { episode: Episode; live: boolean; data: Catalog; surveys: SurveyRow[]; onPatch(fields: Partial<Episode>): void; onFeatured(on: boolean): void; onDuplicate(): void; onDelete(): void; onSeasons(seasons: Season[]): void; uniqueSlug(base: string, self: string): string; onMessage(message: string): void }) {
  const [audioStatus, setAudioStatus] = useState(""), [coverStatus, setCoverStatus] = useState(""), [busy, setBusy] = useState<"" | "audio" | "cover">("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const historyRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0), [history, setHistory] = useState<Array<{ version: Version; found: Episode | null }> | null>(null);
  const stream = streamUrl(episode);

  /** העלאת קובץ לתוכנית — מכפתור הבחירה או מגרירה. הקלטה עד 1GB (בחלקים), תמונה עם גרסה קטנה לכרטיסים */
  const uploadOne = async (kind: "audio" | "cover", picked: File) => {
    const setStatus = kind === "audio" ? setAudioStatus : setCoverStatus;
    setBusy(kind); setStatus("מתחילים להעלות…");
    try {
      const progress = (pct: number) => setStatus(`מעלים את ${picked.name} — ${pct}%`);
      if (kind === "cover") onPatch(await setCover(episode, await shrinkImage(picked), progress));
      else onPatch({ audio: await uploadFile(picked, episode.id, "audio", progress), duration: 0 });
      setStatus(""); onMessage("הקובץ הועלה. כשתפרסמו, הוא יופיע באתר.");
    } catch (error) { setStatus(errorText(error, "ההעלאה נכשלה.")); }
    setBusy("");
  };
  const onUpload = (kind: "audio" | "cover") => async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget, picked = input.files?.[0]; input.value = ""; if (!picked) return;
    await uploadOne(kind, picked);
  };
  const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types?.includes("Files");
  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      const kind = fileKind(file);
      if (!kind) { onMessage(`"${file.name}" אינו קובץ שמע או תמונה.`); continue; }
      await uploadOne(kind, file);
    }
  };
  const autoCover = async () => {
    setBusy("cover"); setCoverStatus("מציירים…");
    try { const blob = await drawCover(episode, attempt); onPatch(await setCover(episode, blob, (pct) => setCoverStatus(`מעלים — ${pct}%`))); setAttempt(attempt + 1); setCoverStatus(""); onMessage("התמונה נוצרה. לא אהבתם? לחצו שוב לגרסה אחרת."); }
    catch (error) { setCoverStatus(errorText(error, "יצירת התמונה נכשלה.")); }
    setBusy("");
  };
  const share = async () => {
    const url = `${PROGRAM_SITE}episode.html?ep=${encodeURIComponent(episode.slug)}`;
    const text = [`🎙️ ראש בראש${episode.number != null ? ` · תוכנית ${episode.number}` : ""}`, `*${label(episode)}*`, fmtDate(episode.date), episode.description.split(/\n+/)[0].trim().slice(0, 200), `להאזנה: ${url}`].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(text); onMessage("הטקסט הועתק — הדביקו בוואטסאפ."); } catch { onMessage("ההעתקה לא הצליחה."); }
  };
  const loadHistory = async () => {
    setHistory([]); requestAnimationFrame(() => historyRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    try {
      const { versions } = await api<{ versions: Version[] }>("/api/program/versions");
      const rows: Array<{ version: Version; found: Episode | null }> = []; let previous: string | null = null;
      for (const version of versions) {
        const { data: snapshot } = await api<{ data: Record<string, unknown> }>(`/api/program/versions/${version.id}`);
        const raw = (Array.isArray(snapshot.episodes) ? snapshot.episodes as Array<Record<string, unknown>> : []).find((e) => e.id === episode.id);
        const found = raw ? normEpisode(raw, 0) : null, key = found ? pack(found) : null;
        if (key !== previous) rows.push({ version, found }); previous = key;
      }
      setHistory(rows);
    } catch (error) { setHistory(null); onMessage(errorText(error, "טעינת הגרסאות נכשלה.")); }
  };
  const newSeason = () => {
    const title = prompt("איך לקרוא לעונה החדשה? (למשל: עונת 2027)"); if (!title) return;
    const year = title.match(/\d{4}/)?.[0]; let id = slugify(year || title), n = 2; while (data.seasons.some((s) => s.id === id)) id = `${slugify(year || title)}-${n++}`;
    onSeasons([...data.seasons, { id, title: title.trim(), year: year ? Number(year) : null, note: "" }]); onPatch({ season: id });
  };

  return <div className={`prog-drop${dragging ? " ready" : ""}`}
    onDragEnter={(e) => { if (!hasFiles(e)) return; dragDepth.current++; setDragging(true); }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
    onDrop={onDrop}>
    {dragging && <div className="prog-drop-hint" aria-hidden="true">שחררו כאן — הקלטה או תמונה לתוכנית „{label(episode)}”</div>}
    <Section title={label(episode)} aside={<div className="row-actions">
      {live ? <a href={`${PROGRAM_SITE}episode.html?ep=${encodeURIComponent(episode.slug)}`} target="_blank" rel="noopener">צפייה באתר ↗</a> : <button type="button" onClick={() => onMessage("התוכנית עוד לא באתר. היא תופיע אחרי „פרסום התוכניות”.")}>צפייה באתר ↗</button>}
      <button type="button" onClick={share}>טקסט לוואטסאפ</button><button type="button" onClick={() => openMailDraft(episode.id, onMessage)}>✉ מייל למאזינים</button><button type="button" onClick={onDuplicate}>שכפול</button><button type="button" onClick={() => (history ? setHistory(null) : loadHistory())}>{history ? "הסתרת הגרסאות" : "גרסאות קודמות"}</button><button type="button" className="danger" onClick={onDelete}>מחיקה</button>
    </div>}>
      <div className="prog-form">
        <label className="wide"><span>שם התוכנית</span><input value={episode.title} placeholder="למשל: שירי הסתיו" onChange={(e) => onPatch({ title: e.target.value })} /></label>
        <label><span>תאריך השידור</span><input type="date" value={episode.date} onChange={(e) => onPatch({ date: e.target.value })} /></label>
        <label><span>מספר התוכנית</span><input type="number" value={episode.number ?? ""} onChange={(e) => onPatch({ number: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        <label><span>עונה</span><select value={episode.season} onChange={(e) => (e.target.value === "__new" ? newSeason() : onPatch({ season: e.target.value }))}><option value="">בלי עונה</option>{data.seasons.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}<option value="__new">+ עונה חדשה…</option></select></label>
        <label><span>אורחים</span><input value={episode.guests.join(", ")} placeholder="שמות, מופרדים בפסיק" onChange={(e) => onPatch({ guests: splitList(e.target.value) })} /></label>
        <label className="wide"><span>על התוכנית</span><textarea value={episode.description} placeholder="כמה משפטים על מה שהיה בתוכנית." onChange={(e) => onPatch({ description: e.target.value })} /></label>
        <label><span>מקושרת למצעד (לא חובה)</span><select value={episode.surveyId} onChange={(e) => onPatch({ surveyId: e.target.value })}><option value="">בלי מצעד</option>{surveys.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? " · הפעיל" : ""}{s.open ? " · ההצבעה פתוחה" : ""}</option>)}{episode.surveyId && !surveys.some((s) => s.id === episode.surveyId) && <option value={episode.surveyId}>מצעד שנמחק</option>}</select><small>דף התוכנית יציג קישור להצבעה כשהמצעד פתוח.</small></label>
        <label><span>פרסום מתוזמן (לא חובה)</span><input type="datetime-local" value={episode.publishAt} onChange={(e) => onPatch({ publishAt: e.target.value })} /><small>{episode.publishAt ? (scheduled(episode) ? `תופיע באתר ב־${when(episode.publishAt)}.` : "המועד עבר — מוצגת כרגיל.") : "ריק = מופיעה מיד אחרי הפרסום."}</small></label>
      </div>
      <div className="prog-switches">
        <Switch on={episode.visible} onClick={() => onPatch({ visible: !episode.visible })}>{episode.visible ? "מוצגת באתר" : "מוסתרת מהאתר"}</Switch>
        <Switch on={episode.featured} onClick={() => onFeatured(!episode.featured)}>המומלצת בדף הבית</Switch>
        {episode.publishAt && <button type="button" onClick={() => onPatch({ publishAt: "" })}>ביטול התזמון</button>}
      </div>
      {history && <div className="prog-history" ref={historyRef}>
        <h3>גרסאות קודמות של התוכנית</h3>
        {!history.length ? <p className="panel-help">טוענים… (גרסה נשמרת בכל פרסום)</p> : <div className="admin-list">{history.map(({ version, found }) => <article key={version.id}><div><span><b>{when(version.createdAt)}</b><small>{found ? `${found.title || "בלי שם"}${found.date ? ` · ${fmtDate(found.date)}` : ""}` : "התוכנית לא הייתה קיימת"}{version.by ? ` · ${version.by}` : ""}</small></span></div>{found && <button type="button" onClick={() => { onPatch(found); setHistory(null); onMessage("התוכנית שוחזרה לטיוטה. פרסמו כדי להעלות לאתר."); }}>שחזור</button>}</article>)}</div>}
        <button type="button" className="prog-btn" onClick={() => setHistory(null)}>סגירה</button>
      </div>}
    </Section>

    <Section title="ההקלטה" aside={episode.duration ? <strong className="prog-badge">{fmtDuration(episode.duration)}</strong> : undefined}>
      <p className={`prog-note ${stream ? "ok" : ""}`}>{stream ? "✓ יש הקלטה לתוכנית הזו. המאזינים שומעים אותה בנגן של האתר." : "עדיין אין הקלטה. העלו קובץ, גררו אותו לכאן או הדביקו קישור."}</p>
      {stream && <audio className="prog-audio" controls preload="metadata" src={stream} onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (!episode.duration && Number.isFinite(d)) onPatch({ duration: Math.round(d) }); }} />}
      <div className="prog-form">
        <div className="prog-field"><span>{stream ? "החלפת ההקלטה" : "העלאת ההקלטה"}</span><FilePick accept=".mp3,.m4a,.wav,.ogg,.flac,.aac" disabled={busy === "audio"} onChange={onUpload("audio")}>{busy === "audio" ? "מעלים…" : "⬆ בחירת קובץ הקלטה מהמחשב"}</FilePick><small>{audioStatus || "קובץ שמע (MP3 וכו') עד 1GB — גם תוכנית של שעתיים. אפשר גם לגרור את הקובץ לכאן."}</small></div>
        <label><span>או קישור להקלטה</span><input dir="ltr" value={episode.audio} placeholder="https://…" onChange={(e) => onPatch({ audio: e.target.value, duration: 0 })} /><small>קישור שיתוף לקובץ בדרייב מספיק.</small></label>
      </div>
    </Section>

    <Section title="התמונה">
      <div className="prog-cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {episode.cover ? <img src={episode.cover} alt="" /> : <div className="prog-cover-empty">♫<small>בלי תמונה האתר מציג עטיפה צבעונית משלו</small></div>}
        <div className="prog-form single">
          <div className="prog-field"><span>יצירת תמונה אוטומטית</span><button type="button" className="prog-primary" disabled={busy === "cover"} onClick={autoCover}>{episode.cover ? "יצירת תמונה חדשה" : "ליצור תמונה עכשיו"}</button><small>{coverStatus || "עטיפה בסגנון האתר עם שם התוכנית, המספר ומשפט מהתיאור."}</small></div>
          <div className="prog-field"><span>או תמונה משלכם</span><FilePick accept=".jpg,.jpeg,.png,.webp" disabled={busy === "cover"} onChange={onUpload("cover")}>{busy === "cover" ? "מעלים…" : "⬆ בחירת תמונה מהמחשב"}</FilePick><small>או גררו תמונה לכאן. נשמרת גם גרסה קטנה לכרטיסים.</small></div>
          <label><span>או קישור לתמונה</span><input dir="ltr" value={episode.cover} placeholder="https://…" onChange={(e) => onPatch({ cover: e.target.value, thumb: "" })} /></label>
          {episode.cover && <button type="button" className="danger" onClick={() => onPatch({ cover: "", thumb: "" })}>הסרת התמונה</button>}
        </div>
      </div>
    </Section>

    <details className="admin-panel prog-more">
      <summary><span>עוד פרטים</span><small>מילות חיפוש, כתובת הדף וקישורים — לא חובה</small></summary>
      <div className="prog-form single">
        <label><span>מילות חיפוש</span><input value={episode.tags.join(", ")} placeholder="למשל: מצעד, ראיון, חנוכה" onChange={(e) => onPatch({ tags: splitList(e.target.value) })} /><small>עוזרות למאזינים למצוא את התוכנית. מופרדות בפסיק.</small></label>
        <label><span>כתובת הדף</span><input dir="ltr" value={episode.slug} onChange={(e) => onPatch({ slug: e.target.value })} onBlur={(e) => onPatch({ slug: uniqueSlug(e.target.value, episode.id) })} /><small>{PROGRAM_SITE}episode.html?ep={episode.slug}</small></label>
        <div className="prog-field"><span>קישורים בדף התוכנית</span>
          {episode.links.map((link, i) => <div key={i} className="prog-link-row"><input value={link.label} placeholder="מה זה? (למשל: הפלייליסט)" onChange={(e) => onPatch({ links: episode.links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)) })} /><input dir="ltr" value={link.url} placeholder="https://…" onChange={(e) => onPatch({ links: episode.links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)) })} /><button type="button" className="danger" onClick={() => onPatch({ links: episode.links.filter((_, j) => j !== i) })}>✕</button></div>)}
          <button type="button" className="prog-btn" onClick={() => onPatch({ links: [...episode.links, { label: "", url: "" }] })}>+ הוספת קישור</button>
        </div>
      </div>
    </details>

    {stream && <AiCard episode={episode} onPatch={onPatch} onMessage={onMessage} />}
  </div>;
}

/* ======================= 2. הודעה ועדכונים ======================= */

function SiteSection({ data, change, onMessage }: Common) {
  const banner = data.settings.banner, updates = data.settings.updates, contacts = data.settings.contacts;
  const setBanner = (fields: Partial<Banner>) => change({ ...data, settings: { ...data.settings, banner: { ...banner, ...fields } } });
  const setUpdates = (next: Update[]) => change({ ...data, settings: { ...data.settings, updates: next } });
  const setContacts = (fields: Partial<Contacts>) => change({ ...data, settings: { ...data.settings, contacts: { ...contacts, ...fields } } });
  const counts = data.episodes.reduce<Record<string, number>>((acc, e) => { acc[e.season] = (acc[e.season] || 0) + 1; return acc; }, {});
  const setSeason = (i: number, fields: Partial<Season>) => change({ ...data, seasons: data.seasons.map((s, j) => (j === i ? { ...s, ...fields } : s)) });
  return <>
    <Section title="הודעה בראש האתר" aside={<strong className={`prog-badge${banner.enabled ? " ok" : " off"}`}>{banner.enabled ? "● מוצגת עכשיו" : "○ לא מוצגת"}</strong>}>
      <p className="panel-help">פס הודעה בראש הדפים — למשל „התוכנית הבאה ביום חמישי” או ברכה לחג. נעלם לבד בתאריך שתבחרו.</p>
      <div className="prog-form">
        <label className="wide"><span>ההודעה</span><input value={banner.text} maxLength={300} placeholder="למשל: התוכנית הבאה — יום חמישי ב־20:00" onChange={(e) => setBanner({ text: e.target.value })} /></label>
        <label><span>קישור (לא חובה)</span><input dir="ltr" value={banner.link} placeholder="https://…" onChange={(e) => setBanner({ link: e.target.value })} /></label>
        <label><span>טקסט הכפתור</span><input value={banner.linkLabel} placeholder="לפרטים" onChange={(e) => setBanner({ linkLabel: e.target.value })} /></label>
        <label><span>להציג עד (לא חובה)</span><input type="date" value={banner.until} onChange={(e) => setBanner({ until: e.target.value })} /></label>
        <div className="prog-field"><span>איפה להציג</span><label className="prog-check"><input type="checkbox" checked={banner.sites.program} onChange={(e) => setBanner({ sites: { ...banner.sites, program: e.target.checked } })} /> באתר התוכניות</label><label className="prog-check"><input type="checkbox" checked={banner.sites.survey} onChange={(e) => setBanner({ sites: { ...banner.sites, survey: e.target.checked } })} /> באתר הסקר</label></div>
      </div>
      <div className="prog-switches"><Switch on={banner.enabled} onClick={() => { if (!banner.enabled && !banner.text.trim()) return onMessage("כתבו קודם את ההודעה, ואז הפעילו אותה."); setBanner({ enabled: !banner.enabled }); }}>להציג את ההודעה</Switch></div>
      {banner.enabled && banner.text && <div className="shared-banner prog-banner-preview"><span aria-hidden="true">✦</span><p>{banner.text}</p>{banner.link && <a>{banner.linkLabel || "לפרטים"} ←</a>}</div>}
    </Section>

    <Section title="דף העדכונים" aside={<strong className="prog-badge">{updates.length}</strong>}>
      <p className="panel-help">הודעות קצרות למאזינים בדף „עדכונים” באתר התוכניות. החדש למעלה; אפשר לנעוץ עדכון חשוב.</p>
      <button type="button" className="prog-primary" onClick={() => setUpdates([{ id: `u-${Date.now().toString(36)}`, date: today(), title: "", text: "", link: "", pinned: false }, ...updates])}>+ עדכון חדש</button>
      <div className="prog-updates">{updates.map((u, i) => <article key={u.id} className={u.pinned ? "pinned" : ""}>
        <div className="prog-update-head"><input type="date" value={u.date} onChange={(e) => setUpdates(updates.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} /><input value={u.title} placeholder="כותרת" onChange={(e) => setUpdates(updates.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /><Switch on={u.pinned} onClick={() => setUpdates(updates.map((x, j) => (j === i ? { ...x, pinned: !x.pinned } : x)))}>נעוץ למעלה</Switch><button type="button" className="danger" onClick={() => { if (confirm("למחוק את העדכון?")) setUpdates(updates.filter((_, j) => j !== i)); }}>מחיקה</button></div>
        <textarea value={u.text} placeholder="תוכן העדכון" onChange={(e) => setUpdates(updates.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
        <input dir="ltr" value={u.link} placeholder="קישור (לא חובה)" onChange={(e) => setUpdates(updates.map((x, j) => (j === i ? { ...x, link: e.target.value } : x)))} />
      </article>)}{!updates.length && <p className="panel-help">עדיין אין עדכונים.</p>}</div>
    </Section>

    <Section title="פרטי קשר">
      <p className="panel-help">מה שמופיע בדף הבית של אתר התוכניות בכרטיסים „גם בטלפון” ו„הקול שלכם”. שדה ריק לא מוצג. מתפרסם יחד עם התוכניות.</p>
      <div className="prog-form">
        <label><span>טלפון ראשי</span><input dir="ltr" inputMode="tel" maxLength={30} value={contacts.phone} onChange={(e) => setContacts({ phone: e.target.value })} /></label>
        <label><span>טלפון נוסף</span><input dir="ltr" inputMode="tel" maxLength={30} value={contacts.phone2} onChange={(e) => setContacts({ phone2: e.target.value })} /></label>
        <label className="wide"><span>מה יש בקו (השלוחות)</span><textarea maxLength={500} value={contacts.phoneNote} onChange={(e) => setContacts({ phoneNote: e.target.value })} /></label>
        <label className="wide"><span>איך מדברים עם המגישים</span><textarea maxLength={500} value={contacts.hostsNote} onChange={(e) => setContacts({ hostsNote: e.target.value })} /></label>
        <label><span>מייל (לתפוצה ולצ׳אט)</span><input dir="ltr" type="email" maxLength={120} value={contacts.email} onChange={(e) => setContacts({ email: e.target.value })} /></label>
        <label><span>הערה להצטרפות לצ׳אט</span><input maxLength={500} value={contacts.chatNote} onChange={(e) => setContacts({ chatNote: e.target.value })} /></label>
      </div>
    </Section>

    <Section title="עונות" aside={<strong className="prog-badge">{data.seasons.length}</strong>}>
      <p className="panel-help">עונה היא קבוצה של תוכניות — לפי שנה, תקופה או מגישים. בארכיון אפשר לסנן לפי עונה. מחיקת עונה לא מוחקת תוכניות.</p>
      <div className="prog-seasons">{data.seasons.map((s, i) => <div key={s.id}><input value={s.title} placeholder="שם העונה" onChange={(e) => setSeason(i, { title: e.target.value })} /><input type="number" value={s.year ?? ""} placeholder="שנה" onChange={(e) => setSeason(i, { year: e.target.value ? Number(e.target.value) : null })} /><input value={s.note} placeholder="הערה" onChange={(e) => setSeason(i, { note: e.target.value })} /><small>{counts[s.id] || 0} תוכניות</small><button type="button" className="danger" onClick={() => { if (confirm(`למחוק את העונה "${s.title}"?`)) change({ ...data, seasons: data.seasons.filter((_, j) => j !== i), episodes: data.episodes.map((e) => (e.season === s.id ? { ...e, season: "" } : e)) }); }}>✕</button></div>)}</div>
      <button type="button" className="prog-btn" onClick={() => { const y = new Date().getFullYear(); let id = String(y), n = 2; while (data.seasons.some((s) => s.id === id)) id = `${y}-${n++}`; change({ ...data, seasons: [...data.seasons, { id, title: `עונת ${y}`, year: y, note: "" }] }); }}>+ עונה חדשה</button>
    </Section>
  </>;
}

/* ======================= 3. מאזינים ======================= */

type CommentsState = { comments: Comment[]; pending: number; error: string };

function ListenersSection({ data, onMessage }: { data: Catalog; onMessage(message: string): void }) {
  const [stats, setStats] = useState<Stats | null>(null), [messages, setMessages] = useState<{ messages: Message[]; unread: number } | null>(null), [subs, setSubs] = useState<{ active: number; fromProgram: number } | null>(null);
  const [comments, setComments] = useState<CommentsState | null>(null), [pushCount, setPushCount] = useState<number | null>(null);
  const [error, setError] = useState(""), [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<Stats>("/api/program/stats"), api<{ messages: Message[]; unread: number }>("/api/program/messages"), api<{ active: number; fromProgram: number }>("/api/program/subscribers/count").catch(() => null),
      api<{ comments: CommentsState["comments"]; pending: number }>("/api/program/comments/all?status=all").then((r) => ({ ...r, error: "" })).catch((cause) => ({ comments: [], pending: 0, error: commentsError(cause) })),
      api<{ total: number }>("/api/program/push/count").then((r) => Number(r.total) || 0).catch(() => null),
    ])
      .then(([s, m, c, cm, p]) => { if (active) { setStats(s); setMessages(m); setSubs(c); setComments(cm); setPushCount(p); setError(""); } })
      .catch((cause) => { if (active) setError(errorText(cause, "הטעינה נכשלה.")); });
    return () => { active = false; };
  }, [tick]);
  const name = (id: string | null) => { const e = data.episodes.find((x) => x.id === id); return e ? label(e) : "תוכנית שנמחקה"; };
  const act = async (path: string, init: RequestInit) => { try { await api(path, init); setTick((v) => v + 1); } catch (cause) { onMessage(errorText(cause, "הפעולה נכשלה.")); } };
  if (error) return <Section title="מאזינים"><p className="panel-help">{error}</p></Section>;
  if (!stats || !messages) return <Section title="מאזינים"><p className="panel-help">טוענים…</p></Section>;
  const max = Math.max(1, ...stats.days.map((d) => Number(d.plays) || 0));
  const cfg = stats.config, from = cfg ? fmtDate(cfg.since) : "";
  const top = (rows: Stats["recent"]) => rows.filter((r) => Number(r.plays)).slice(0, 10);
  return <>
    <Section title="מי מאזין" aside={<button type="button" className="prog-btn" onClick={() => { setTick((v) => v + 1); onMessage("המספרים עודכנו."); }}>↻ רענון</button>}>
      {cfg && <p className="panel-help">סופרים מ־{from}. האזנה נספרת אחרי {minutesText(Math.round(cfg.minSeconds / 60))} האזנה; האזנה מלאה — שמעו 90% מהתוכנית.</p>}
      <div className={`stat-grid prog-stats${cfg ? " six" : ""}`}><article><small>האזנות בשבוע האחרון</small><b>{n2(stats.week.plays)}</b></article><article><small>מאזינים בשבוע האחרון</small><b>{n2(stats.week.listeners)}</b></article><article><small>{cfg ? `האזנות מאז ${from}` : "האזנות מאז ההתחלה"}</small><b>{n2(stats.totals.plays)}</b></article>{cfg && <><article><small>האזנות מלאות</small><b>{n2(stats.totals.full)}</b></article><article><small>הורדות</small><b>{n2(stats.totals.downloads)}</b></article></>}<article><small>שעות האזנה</small><b>{n2(Math.round((Number(stats.totals.seconds) || 0) / 3600))}</b></article></div>
      <h3>30 הימים האחרונים</h3>
      {stats.days.length ? <div className="prog-bars">{stats.days.map((d) => <div key={d.day} title={`${fmtDate(d.day)}: ${n2(d.plays)} האזנות${cfg ? `, ${n2(d.full)} מלאות, ${n2(d.downloads)} הורדות` : ""}`}><i style={{ height: `${Math.round(((Number(d.plays) || 0) / max) * 100)}%` }} /><small>{d.day.slice(8)}</small></div>)}</div> : <p className="panel-help">עדיין אין האזנות שנרשמו.</p>}
      <div className="prog-two">
        <div><h3>הכי נשמעות החודש</h3><ol className="prog-top">{top(stats.recent).map((r) => <li key={r.id}><span>{name(r.id)}</span><b>{n2(r.plays)}</b></li>)}</ol></div>
        <div><h3>{cfg ? `הכי נשמעות מאז ${from}` : "הכי נשמעות מאז ומעולם"}</h3><ol className="prog-top">{top(stats.episodes).map((r) => <li key={r.id}><span>{name(r.id)}</span><b>{n2(r.plays)}</b></li>)}</ol></div>
      </div>
      {cfg && <><h3>לכל תוכנית (מאז {from})</h3><EpisodeTable rows={stats.episodes} name={name} /></>}
      <p className="panel-help">מכשירים החודש: טלפון {n2(stats.devices.phone)} · מחשב {n2(stats.devices.desktop)}. הספירה אנונימית.</p>
      {/* הגדרת ספירה חדשה — המספרים של כל תוכנית נטענים מחדש */}
      <DeepStats key={cfg ? `${cfg.since}:${cfg.minSeconds}` : "all"} stats={stats} data={data} />
      {cfg && <CountSettings config={cfg} onSaved={() => setTick((v) => v + 1)} onMessage={onMessage} />}
    </Section>
    <Section title="הודעות מהמאזינים" aside={messages.unread ? <strong className="prog-badge warn">{messages.unread} חדשות</strong> : undefined}>
      {messages.messages.length ? <div className="prog-messages">{messages.messages.map((m) => <article key={m.id} className={m.readAt ? "" : "unread"}>
        <header><b>{m.name || "מאזין/ה"}</b>{m.email && <a href={`mailto:${m.email}`}>{m.email}</a>}<small>{when(m.createdAt)}{m.episodeId ? ` · על "${name(m.episodeId)}"` : ""}</small></header>
        <p>{m.text}</p>
        <div className="row-actions"><button type="button" onClick={() => act("/api/program/messages/read", { method: "POST", body: JSON.stringify({ id: m.id, read: !m.readAt }) })}>{m.readAt ? "סימון כלא נקרא" : "✓ נקרא"}</button>{m.email && <a href={`mailto:${m.email}?subject=${encodeURIComponent("תשובה מראש בראש")}`}>תשובה במייל</a>}<button type="button" className="danger" onClick={() => { if (confirm("למחוק את ההודעה?")) act("/api/program/messages", { method: "DELETE", body: JSON.stringify({ id: m.id }) }); }}>מחיקה</button></div>
      </article>)}</div> : <p className="panel-help">עדיין לא הגיעו הודעות. המאזינים כותבים דרך „כתבו לנו” באתר התוכניות.</p>}
    </Section>
    <CommentsCard data={data} comments={comments} onChange={setComments} onMessage={onMessage} />
    <PushCard data={data} count={pushCount} onCount={setPushCount} onMessage={onMessage} />
    {subs && <Section title="רשימת התפוצה"><p className="panel-help">{n2(subs.active)} נרשמים פעילים, מהם {n2(subs.fromProgram)} דרך אתר התוכניות. הרשימה המלאה בלשונית „רשימת תפוצה”.</p></Section>}
  </>;
}

/* ======================= 4. פרסום ======================= */

type Changes = { added: number; changed: number; removed: Episode[]; seasons: boolean; settings: boolean; any: boolean } | null;
type Conflict = { who: string };
/** קבוצות בבדיקת התקינות: שם, והעבודה שמתקנת את כולן בלחיצה אחת */
const HEALTH_GROUPS: Array<{ key: string; title: string; hint: string; test(e: Episode): boolean; fix?: string; fixLabel?: string; confirm?(n: number): string }> = [
  { key: "noaudio", title: "תוכניות בלי הקלטה", hint: "המאזינים לא יוכלו לשמוע אותן", test: (e) => !streamUrl(e) },
  { key: "noduration", title: "תוכניות בלי אורך", hint: "האורך נקרא מהקובץ עצמו", test: (e) => !!streamUrl(e) && !e.duration, fix: "fill-durations", fixLabel: "מילוי האורך לכולן" },
  { key: "nocover", title: "תוכניות בלי תמונה", hint: "האתר מציג להן עטיפה צבעונית; אפשר ליצור תמונה בלחיצה", test: (e) => !e.cover, fix: "covers-all", fixLabel: "יצירת תמונה לכולן", confirm: (n) => `ליצור תמונה אוטומטית ל־${n} תוכניות בלי תמונה?` },
  { key: "nothumb", title: "תוכניות בלי תמונה קטנה לכרטיסים", hint: "הארכיון ודף הבית ייטענו מהר יותר עם גרסה של 640 פיקסלים", test: (e) => !!e.cover && !e.thumb, fix: "thumbs-all", fixLabel: "יצירת תמונות קטנות" },
  { key: "nodesc", title: "תוכניות בלי תיאור אמיתי", hint: "ה־AI מתמלל את ההקלטה וכותב תיאור וסיכום", test: (e) => !!streamUrl(e) && !hasRealDescription(e), fix: "ai-all", fixLabel: "תיאור אוטומטי מהתמלול", confirm: () => "לתמלל ולכתוב תיאור וסיכום לכל התוכניות בלי תיאור אמיתי? זה לוקח כמה דקות לכל תוכנית, ואפשר לעצור באמצע." },
  { key: "nodate", title: "תוכניות בלי תאריך", hint: "הן יופיעו בסוף הארכיון", test: (e) => !e.date },
  { key: "schedhidden", title: "מתוזמנות אבל מוסתרות", hint: "המועד עבר, אבל התוכנית עדיין מוסתרת", test: (e) => !!e.publishAt && !scheduled(e) && !e.visible },
];

function HealthGroup({ group, items, onFix }: { group: typeof HEALTH_GROUPS[number]; items: Episode[]; onFix(): void }) {
  const job = useJob(group.fix || "");
  return <details><summary><b>{items.length}</b><span>{group.title}</span><small>{group.hint}</small>
    {group.fix && (job?.running ? <span className="prog-job"><Status text={job.text} /><button type="button" onClick={(e) => { e.preventDefault(); stopJob(group.fix!); }}>עצירה</button></span> : <button type="button" className="prog-btn" onClick={(e) => { e.preventDefault(); onFix(); }}>{group.fixLabel}</button>)}
  </summary><ul className="prog-problems">{items.slice(0, 120).map((e) => <li key={e.id}>{label(e)}</li>)}{items.length > 120 && <li>ועוד {items.length - 120}…</li>}</ul></details>;
}

function PublishSection({ data, change, mutate, patchEpisode, onMessage, origin, changes, base, onOpen, onPublished, onDiscard }: Common & { origin: Catalog; changes: Changes; base: { current: string | null }; onOpen(id: string | null): void; onPublished(published: Catalog, versionId: string | null): void; onDiscard(): void }) {
  const [busy, setBusy] = useState(false), [versions, setVersions] = useState<Version[] | null>(null), [preview, setPreview] = useState("");
  const [notify, setNotify] = useState(true), [conflict, setConflict] = useState<Conflict | null>(null);
  // התוכניות שעלו לאתר בפרסום האחרון — להן מציעים טיוטת מייל לרשימת התפוצה
  const [fresh, setFresh] = useState<Episode[]>([]);
  const [checks, setChecks] = useState<Record<string, { running: boolean; done: number; total: number; problems: Array<{ id: string; text: string }> }>>({});
  const [migrate, setMigrate] = useState<{ running: boolean; done: number; total: number; moved: number; had: number; failed: string[] } | null>(null);
  const stopMigrate = useRef(false), fileInput = useRef<HTMLInputElement>(null);

  const health = useMemo(() => {
    const must: Array<{ id: string; text: string }> = [], dup: string[] = [];
    const byNumber = new Map<number, Episode[]>(), byTitle = new Map<string, Episode[]>(), byDrive = new Map<string, Episode[]>();
    for (const e of data.episodes) {
      if (!e.title.trim()) must.push({ id: e.id, text: `תוכנית בלי שם${e.number != null ? ` (תוכנית ${e.number})` : ""}${e.date ? ` מתאריך ${fmtDate(e.date)}` : ""}` });
      if (e.number != null) byNumber.set(e.number, [...(byNumber.get(e.number) || []), e]);
      const t = e.title.trim().toLowerCase(); if (t) byTitle.set(t, [...(byTitle.get(t) || []), e]);
      const d = driveId(e); if (d) byDrive.set(d, [...(byDrive.get(d) || []), e]);
    }
    for (const [n, l] of byNumber) if (l.length > 1) dup.push(`${l.length} תוכניות עם המספר ${n}: ${l.map(label).join(", ")}`);
    for (const [, l] of byTitle) if (l.length > 1) dup.push(`${l.length} תוכניות בשם "${label(l[0])}"`);
    for (const [, l] of byDrive) if (l.length > 1) dup.push(`אותה הקלטה ב־${l.length} תוכניות: ${l.map(label).join(", ")}`);
    const groups = HEALTH_GROUPS.map((g) => ({ group: g, items: data.episodes.filter(g.test) })).filter((g) => g.items.length);
    return { must, dup, groups };
  }, [data.episodes]);

  /* ---------- פרסום: עם הגנה מדריסה (baseVersion), התראה למאזינים, ושליחת ההתראות במנות ---------- */
  const publish = async (force = false) => {
    if (health.must.length) return onMessage(health.must[0].text);
    setBusy(true); setConflict(null); onMessage("מפרסמים…");
    try {
      const removedIds = origin.episodes.filter((o) => !data.episodes.some((e) => e.id === o.id)).map((o) => o.id);
      const isPublic = (e: Episode) => e.visible && !scheduled(e);
      const goingLive = data.episodes.filter((e) => isPublic(e) && !origin.episodes.some((o) => o.id === e.id && isPublic(o)));
      const r = await api<{ versionId?: string; notified?: number }>("/api/program/catalog", { method: "POST", body: JSON.stringify({ seasons: data.seasons, episodes: data.episodes.map((e) => normEpisode(e, 0)), removedIds, settings: data.settings, baseVersion: base.current ?? null, force, notify }) });
      onPublished(normCatalog(JSON.parse(JSON.stringify(data))), r.versionId ?? null); setVersions(null); onMessage("פורסם! אתר התוכניות מציג עכשיו את הגרסה החדשה.");
      setFresh([...goingLive].sort((a, b) => (b.date || "").localeCompare(a.date || "")));
      if (notify && r.notified) drainPush().then((n) => { if (n) onMessage(n === 1 ? "נשלחה התראה למכשיר אחד." : `נשלחה התראה ל־${n} מכשירים.`); });
    } catch (error) {
      const e = error as ApiError;
      if (e.conflict) {
        // מנהל אחר פרסם אחרי שהתחלתם לערוך — לא דורסים בלי לשאול
        setConflict({ who: e.latest?.by ? ` (${e.latest.by}${e.latest.createdAt ? `, ${when(e.latest.createdAt)}` : ""})` : "" });
      } else onMessage(`הפרסום לא הצליח: ${errorText(error, "")}`);
    } finally { setBusy(false); }
  };
  const discard = async () => { if (!confirm("לבטל את כל השינויים שלא פורסמו?")) return; try { await api("/api/program/draft", { method: "DELETE" }); onDiscard(); onMessage("השינויים בוטלו."); } catch (error) { onMessage(errorText(error, "הביטול נכשל.")); } };
  const runCheck = async (kind: "audio" | "media") => {
    const items = kind === "audio" ? data.episodes.filter((e) => streamUrl(e)).map((e) => ({ e, url: streamUrl(e), what: "ההקלטה", img: false }))
      : data.episodes.flatMap((e) => [...(e.cover ? [{ e, url: e.cover, what: "התמונה", img: true }] : []), ...e.links.filter((l) => !/drive\.google|docs\.google/.test(l.url)).map((l) => ({ e, url: l.url, what: `הקישור "${l.label}"`, img: false }))]);
    const state = { running: true, done: 0, total: items.length, problems: [] as Array<{ id: string; text: string }> };
    setChecks((c) => ({ ...c, [kind]: { ...state } }));
    const probe = async (item: typeof items[number]) => {
      if (item.img) return new Promise<boolean>((resolve) => { const img = new Image(); const t = setTimeout(() => resolve(false), 15000); img.onload = () => { clearTimeout(t); resolve(true); }; img.onerror = () => { clearTimeout(t); resolve(false); }; img.src = item.url; });
      try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000); const r = await fetch(item.url, { method: kind === "audio" ? "GET" : "HEAD", headers: kind === "audio" ? { range: "bytes=0-1" } : {}, mode: kind === "audio" ? "cors" : "no-cors", signal: c.signal, cache: "no-store" }); clearTimeout(t); return r.type === "opaque" || r.ok || r.status === 206; } catch { return false; }
    };
    let i = 0;
    const worker = async () => { while (i < items.length) { const item = items[i++]; if (!(await probe(item))) state.problems.push({ id: item.e.id, text: `${item.what} של "${label(item.e)}" לא נטענת` }); state.done++; if (state.done % 5 === 0) setChecks((c) => ({ ...c, [kind]: { ...state, problems: [...state.problems] } })); } };
    await Promise.all([worker(), worker(), worker()]);
    setChecks((c) => ({ ...c, [kind]: { ...state, running: false, problems: [...state.problems] } }));
  };
  const loadVersions = async () => { try { setVersions((await api<{ versions: Version[] }>("/api/program/versions")).versions); } catch (error) { onMessage(errorText(error, "הטעינה נכשלה.")); } };
  const restoreVersion = async (version: Version) => {
    if (!confirm(`לשחזר את הגרסה מ־${when(version.createdAt)}? כל מה שבטיוטה יוחלף. אחר כך מפרסמים.`)) return;
    try { const { data: snapshot } = await api<{ data: Record<string, unknown> }>(`/api/program/versions/${version.id}`); const restored = normCatalog(snapshot); change(snapshot.settings ? restored : { ...restored, settings: data.settings }); onMessage("הגרסה שוחזרה לטיוטה. בדקו ופרסמו."); }
    catch (error) { onMessage(errorText(error, "השחזור נכשל.")); }
  };
  const makePreview = async () => { try { await api("/api/program/draft", { method: "PUT", body: JSON.stringify({ data: { ...data, baseVersion: base.current } }) }); const { preview: p } = await api<{ preview: { token: string } }>("/api/program/preview", { method: "POST" }); setPreview(`${PROGRAM_SITE}index.html?preview=${p.token}`); } catch (error) { onMessage(errorText(error, "יצירת הקישור נכשלה.")); } };
  const backup = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, updated: today(), seasons: data.seasons, episodes: data.episodes, settings: data.settings }, null, 2)], { type: "application/json" })); a.download = `rosh-berosh-programs-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  const restoreFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return;
    let raw: Record<string, unknown>; try { raw = JSON.parse(await file.text()); } catch { return onMessage("זה לא קובץ גיבוי של אתר התוכניות."); }
    if (!Array.isArray(raw.episodes)) return onMessage("בקובץ אין תוכניות.");
    if (!confirm(`לשחזר ${raw.episodes.length} תוכניות מהקובץ? כל מה שבטיוטה יוחלף.`)) return;
    const restored = normCatalog(raw); change(raw.settings ? restored : { ...restored, settings: data.settings }); onMessage("הגיבוי שוחזר לטיוטה. בדקו ופרסמו.");
  };
  const runMigrate = async () => {
    const episodes = data.episodes.filter((e) => driveId(e)); stopMigrate.current = false;
    const state = { running: true, done: 0, total: episodes.length, moved: 0, had: 0, failed: [] as string[] }; setMigrate({ ...state });
    for (const e of episodes) {
      if (stopMigrate.current) break;
      try { const r = await api<{ status: string }>("/api/program/import-drive", { method: "POST", body: JSON.stringify({ episodeId: e.id, driveId: driveId(e), expectedSize: Number(e.sourceFileBytes) || 0 }) }); if (r.status === "existing") state.had++; else state.moved++; }
      catch (error) { state.failed.push(`${label(e)}: ${errorText(error, "נכשל")}`); }
      state.done++; setMigrate({ ...state, failed: [...state.failed] });
    }
    setMigrate({ ...state, running: false, failed: [...state.failed] });
  };

  /* ---------- עבודות על הרבה תוכניות: כל תוצאה נכנסת לטיוטה, ולאתר רק בפרסום ---------- */
  const runFix = (fix: string, items: Episode[]) => {
    const group = HEALTH_GROUPS.find((g) => g.fix === fix);
    if (group?.confirm && !confirm(group.confirm(items.length))) return;
    if (fix === "fill-durations") runJob(fix, items, async (e) => { const duration = await measureDuration(streamUrl(e)); patchEpisode(e.id, { duration }); }, { concurrency: 3, what: "אורכים" }, onMessage);
    else if (fix === "covers-all") runJob(fix, items, async (e) => { patchEpisode(e.id, await setCover(e, await drawCover(e, 0))); }, { concurrency: 2, what: "תמונות" }, onMessage);
    else if (fix === "thumbs-all") runJob(fix, items, async (e) => { const thumb = await uploadFile(new File([await makeThumb(e.cover)], `cover-${e.slug || e.id}-small.jpg`, { type: "image/jpeg" }), e.id, "cover"); patchEpisode(e.id, { thumb }); }, { concurrency: 2, what: "תמונות קטנות" }, onMessage);
    else if (fix === "ai-all") runJob(fix, items, async (e) => { const summary = await aiRun(e.id); patchEpisode(e.id, (current) => summaryPatch(current, summary)); }, { what: "תיאורים" }, onMessage);
  };

  const list: string[] = [];
  if (changes?.added) list.push(changes.added === 1 ? "תוכנית אחת חדשה" : `${changes.added} תוכניות חדשות`);
  if (changes?.changed) list.push(changes.changed === 1 ? "תוכנית אחת עודכנה" : `${changes.changed} תוכניות עודכנו`);
  if (changes?.removed.length) list.push(changes.removed.length === 1 ? `תוכנית אחת תימחק מהאתר (${label(changes.removed[0])})` : `${changes.removed.length} תוכניות יימחקו מהאתר`);
  if (changes?.seasons) list.push("העונות השתנו");
  if (changes?.settings) list.push("ההודעה, העדכונים או פרטי הקשר השתנו");
  const check = (kind: "audio" | "media", title: string, hint: string) => { const r = checks[kind]; return <article><div><span><b>{title}</b><small>{r ? (r.running ? `בודקים… ${r.done}/${r.total}` : r.problems.length ? `${r.problems.length} בעיות:` : `✓ הכול תקין (${r.total} נבדקו)`) : hint}</small>{r && !r.running && !!r.problems.length && <ul className="prog-problems">{r.problems.map((p, i) => <li key={i}>{p.text}</li>)}</ul>}</span></div><button type="button" className="prog-btn" disabled={r?.running} onClick={() => runCheck(kind)}>{r?.running ? "בודקים…" : r ? "↻ בדיקה חוזרת" : "▶ להתחיל בדיקה"}</button></article>; };

  return <>
    <Section title={changes?.any ? "יש שינויים שמחכים לפרסום" : "הכול מפורסם"}>
      <p className="panel-help">{changes?.any ? "עד הפרסום, השינויים נראים רק כאן (ולמי שקיבל קישור תצוגה מקדימה)." : "אתר התוכניות מציג בדיוק את מה שיש כאן."}</p>
      {!!list.length && <ul className="prog-changes">{list.map((x) => <li key={x}>{x}</li>)}</ul>}
      {!!health.must.length && <div className="prog-must"><b>לפני שמפרסמים, צריך לתקן:</b><ul>{health.must.map((p) => <li key={p.id}><button type="button" className="prog-link" onClick={() => onOpen(p.id)}>{p.text}</button></li>)}</ul></div>}
      <div className="row-actions">{changes?.any ? <><button type="button" className="prog-primary big" disabled={!!health.must.length || busy} onClick={() => publish(false)}>{busy ? "מפרסמים…" : "פרסום לאתר התוכניות ←"}</button><button type="button" onClick={discard}>ביטול כל השינויים</button></> : <span className="prog-done">✓ אין שינויים שמחכים לפרסום</span>}</div>
      {!!changes?.added && <label className="prog-check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> לשלוח התראה לטלפון של המאזינים על התוכניות החדשות</label>}
      {fresh.length > 0 && <div className="prog-mail-offer" role="status">
        <p><b>✉ {fresh.length === 1 ? "התוכנית עלתה!" : `${fresh.length} תוכניות עלו!`}</b> מייל מעוצב לרשימת התפוצה — עם כפתור האזנה באתר וקישור הורדה ישיר — נוצר כטיוטה בג׳ימייל שלכם. עורכים, ושולחים משם.</p>
        <div className="row-actions">{fresh.slice(0, 3).map((e) => <button key={e.id} type="button" className="prog-primary" onClick={() => openMailDraft(e.id, onMessage)}>טיוטת מייל{fresh.length > 1 ? `: ${label(e)}` : ""} ←</button>)}<button type="button" onClick={() => setFresh([])}>לא עכשיו</button></div>
      </div>}
      {conflict && <div className="prog-conflict" role="alertdialog" aria-labelledby="prog-conflict-title">
        <h3 id="prog-conflict-title">מנהל אחר פרסם בינתיים</h3>
        <p>מאז שהתחלתם לערוך, מישהו אחר פרסם גרסה חדשה לאתר{conflict.who}. אם תפרסמו עכשיו, השינויים שלו יימחקו ויוחלפו בטיוטה שלכם.</p>
        <p>מומלץ: לפתוח את „גרסאות קודמות” למטה, לראות מה השתנה, ולהעתיק לטיוטה רק את מה שצריך.</p>
        <div className="row-actions"><button type="button" onClick={() => setConflict(null)}>ביטול — לא לפרסם</button><button type="button" className="danger" disabled={busy} onClick={() => publish(true)}>לפרסם בכל זאת ולדרוס</button></div>
      </div>}
    </Section>

    <Section title="בדיקת תקינות" aside={<strong className="prog-badge">{health.groups.length + health.dup.length ? `${health.groups.length + health.dup.length} נושאים` : "✓ תקין"}</strong>}>
      {health.dup.length > 0 && <div className="prog-must soft"><b>כפילויות:</b><ul>{health.dup.map((d) => <li key={d}>{d}</li>)}</ul></div>}
      {health.groups.length ? <><div className="prog-groups">{health.groups.map(({ group, items }) => <HealthGroup key={group.key} group={group} items={items} onFix={() => runFix(group.fix!, items)} />)}</div><p className="panel-help">אלה הצעות בלבד — הן לא חוסמות פרסום. לחיצה על שורה מציגה את התוכניות; הכפתור לצדה מתקן את כולן בבת אחת (ברקע, ואפשר לעצור).</p></> : <p className="panel-help">✓ לכל התוכניות יש שם, תאריך, תיאור, הקלטה, אורך ותמונה, ואין כפילויות.</p>}
      <div className="admin-list">{check("audio", "בדיקת ההקלטות", "עובר על כל ההקלטות ומוודא שהן נטענות בנגן.")}{check("media", "בדיקת תמונות וקישורים", "מוודא שהתמונות נטענות ושהקישורים עונים.")}</div>
    </Section>

    <ProofreadCard data={data} origin={origin} mutate={mutate} onMessage={onMessage} onOpen={onOpen} />

    <Section title="גרסאות קודמות" aside={<button type="button" className="prog-btn" onClick={loadVersions}>{versions ? "↻ רענון" : "הצגת הגרסאות"}</button>}>
      <p className="panel-help">כל פרסום נשמר אוטומטית. שחזור מחזיר גרסה לטיוטה, ואז מפרסמים. גם הגיבוי של לשונית „ארכיון וגיבויים” כולל את אתר התוכניות.</p>
      {versions && (versions.length ? <div className="admin-list">{versions.map((v, i) => <article key={v.id}><div><span><b>{when(v.createdAt)}{i === 0 ? " · הגרסה שבאתר" : ""}</b><small>{n2(v.episodes)} תוכניות{v.by ? ` · ${v.by}` : ""}</small></span></div><button type="button" onClick={() => restoreVersion(v)}>שחזור</button></article>)}</div> : <p className="panel-help">עדיין אין גרסאות — הראשונה תישמר בפרסום הבא.</p>)}
    </Section>

    <details className="admin-panel prog-more">
      <summary><span>כלים מתקדמים</span><small>תצוגה מקדימה, קובץ גיבוי, שחזור והעברת הקלטות</small></summary>
      <div className="admin-list">
        <article><div><span><b>קישור לתצוגה מקדימה</b><small>מישהו אחר יכול לראות את האתר עם הטיוטה לפני הפרסום. עובד עד הפרסום הבא.</small>{preview && <input dir="ltr" readOnly value={preview} onFocus={(e) => e.currentTarget.select()} />}</span></div><button type="button" onClick={makePreview}>יצירת קישור</button></article>
        <article><div><span><b>קובץ גיבוי של אתר התוכניות</b><small>כל התוכניות, העונות וההודעות בקובץ אחד.</small></span></div><button type="button" onClick={backup}>הורדה</button></article>
        <article><div><span><b>שחזור מקובץ</b><small>מחליף את הטיוטה בתוכן של קובץ גיבוי.</small></span></div><button type="button" onClick={() => fileInput.current?.click()}>בחירת קובץ…</button><input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={restoreFile} /></article>
        <article><div><span><b>העברת ההקלטות מהדרייב לאתר</b><small>{migrate ? `${migrate.done}/${migrate.total} · ${migrate.moved} הועברו · ${migrate.had} כבר היו · ${migrate.failed.length} לא הצליחו` : "מעתיק את ההקלטות לאחסון של האתר. אפשר לעצור ולהמשיך."}</small>{!!migrate?.failed.length && <ul className="prog-problems">{migrate.failed.map((f) => <li key={f}>{f}</li>)}</ul>}</span></div>{migrate?.running ? <button type="button" onClick={() => { stopMigrate.current = true; }}>עצירה</button> : <button type="button" onClick={runMigrate}>{migrate ? "המשך / בדיקה חוזרת" : "התחלה"}</button>}</article>
      </div>
    </details>
  </>;
}
