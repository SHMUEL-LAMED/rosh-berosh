"use client";

/* ניהול אתר התוכניות — חלק רגיל של דף הניהול, באותו עיצוב ובאותה כניסה.
   הכול עובד על טיוטה שנשמרת אוטומטית בשרת (/api/program/draft), ו"פרסום"
   מעביר אותה לאתר התוכניות (/api/program/catalog). ארבעה חלקים: תוכניות,
   הודעה ועדכונים, מאזינים, פרסום. */

import type { ChangeEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./programs-admin.css";

export type ProgramSection = "programs" | "site" | "listeners" | "publish";
const PROGRAM_SITE = "https://shmuel-lamed.github.io/rosh-berosh-2/";

type Link = { label: string; url: string };
type Episode = {
  id: string; slug: string; number: number | null; season: string; title: string; date: string; description: string;
  cover: string; audio: string; duration: number; tags: string[]; guests: string[]; links: Link[];
  featured: boolean; visible: boolean; publishAt: string; surveyId: string; [key: string]: unknown;
};
type Season = { id: string; title: string; year: number | null; note: string };
type Banner = { enabled: boolean; text: string; link: string; linkLabel: string; until: string; sites: { program: boolean; survey: boolean } };
type Update = { id: string; date: string; title: string; text: string; link: string; pinned: boolean };
type Catalog = { seasons: Season[]; episodes: Episode[]; settings: { banner: Banner; updates: Update[] } };
type SurveyRow = { id: string; name: string; active: boolean; open: boolean };
type Version = { id: string; by: string; episodes: number; createdAt: number };
type Message = { id: string; name: string; email: string; text: string; episodeId: string | null; readAt: number | null; createdAt: number };
type Stats = { days: Array<{ day: string; plays: number; listeners: number }>; episodes: Array<{ id: string; plays: number }>; recent: Array<{ id: string; plays: number }>; totals: { plays?: number; seconds?: number }; week: { plays?: number; listeners?: number }; devices: Record<string, number> };

/* ---------- עזרים ---------- */

const str = (value: unknown) => (value == null ? "" : String(value));
const list = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
const today = () => new Date().toISOString().slice(0, 10);
const label = (episode: Episode) => episode.title.trim() || "תוכנית בלי שם";
const n2 = (value: unknown) => Number(value || 0).toLocaleString("he-IL");
const splitList = (value: string) => value.split(/[,،]/).map((item) => item.trim()).filter(Boolean);
const when = (value: number | string) => new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(typeof value === "number" ? value * 1000 : value));
const fmtDate = (iso: string) => { if (!iso) return ""; const date = new Date(`${iso.slice(0, 10)}T12:00:00`); return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" }).format(date); };
const fmtDuration = (seconds: number) => { if (!seconds) return ""; const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60); return h ? `${h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`}${m ? ` ו־${m} דקות` : ""}` : `${m} דקות`; };
const slugify = (value: string) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "episode";
const scheduled = (episode: Episode) => !!episode.publishAt && new Date(episode.publishAt) > new Date();

function normEpisode(raw: Record<string, unknown>, index: number): Episode {
  const links = Array.isArray(raw.links) ? (raw.links as Array<Record<string, unknown>>).filter((l) => l && l.url).map((l) => ({ label: str(l.label || l.url), url: str(l.url) })) : [];
  return {
    ...raw,
    id: str(raw.id || raw.slug || `ep-${index}`), slug: str(raw.slug || raw.id || `ep-${index}`),
    number: raw.number == null || raw.number === "" ? null : Number(raw.number), season: str(raw.season), title: str(raw.title),
    date: str(raw.date).slice(0, 10), description: str(raw.description), cover: str(raw.cover), audio: str(raw.audio), duration: Number(raw.duration) || 0,
    tags: list(raw.tags), guests: list(raw.guests), links, featured: !!raw.featured, visible: raw.visible !== false,
    publishAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str(raw.publishAt)) ? str(raw.publishAt).slice(0, 16) : "", surveyId: str(raw.surveyId),
  };
}
function normCatalog(raw: Record<string, unknown> | null | undefined): Catalog {
  const seasons = (Array.isArray(raw?.seasons) ? raw.seasons as Array<Record<string, unknown>> : []).map((s, i) => ({ id: str(s.id || `s${i + 1}`), title: str(s.title || `עונה ${i + 1}`), year: s.year ? Number(s.year) : null, note: str(s.note) }));
  const episodes = (Array.isArray(raw?.episodes) ? raw.episodes as Array<Record<string, unknown>> : []).map(normEpisode);
  const settings = (raw?.settings && typeof raw.settings === "object" ? raw.settings : {}) as Record<string, unknown>;
  const b = (settings.banner && typeof settings.banner === "object" ? settings.banner : {}) as Record<string, unknown>;
  const sites = (b.sites && typeof b.sites === "object" ? b.sites : {}) as Record<string, unknown>;
  const banner: Banner = { enabled: !!b.enabled, text: str(b.text), link: str(b.link), linkLabel: str(b.linkLabel), until: str(b.until).slice(0, 10), sites: { program: sites.program !== false, survey: sites.survey === true } };
  const updates = (Array.isArray(settings.updates) ? settings.updates as Array<Record<string, unknown>> : []).map((u, i) => ({ id: str(u.id || `u${i}`), date: str(u.date).slice(0, 10), title: str(u.title), text: str(u.text), link: str(u.link), pinned: !!u.pinned }));
  return { seasons, episodes, settings: { banner, updates } };
}
/** מה שנשמר ומתפרסם — בלי שדות מחושבים, כדי שההשוואה תהיה נקייה */
const pack = (episode: Episode) => JSON.stringify(normEpisode(episode, 0));

function driveId(episode: Episode): string | null {
  for (const value of [episode.audio, ...episode.links.map((l) => l.url)]) {
    try { const u = new URL(value); if (u.protocol === "https:" && u.hostname === "drive.google.com") { const id = u.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1] || u.searchParams.get("id"); if (id && /^[\w-]+$/.test(id)) return id; } }
    catch { /* not a URL */ }
  }
  return null;
}
/** מה הנגן מנגן: הזרמה דרך השרת לקובצי דרייב, אחרת הקובץ עצמו */
function streamUrl(episode: Episode): string {
  const id = driveId(episode);
  if (id) return `/api/program/stream/${encodeURIComponent(id)}`;
  try { const u = new URL(episode.audio); return u.protocol === "https:" || u.protocol === "http:" ? episode.audio : ""; } catch { return ""; }
}

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error((body as { error?: string }).error || `הפעולה נכשלה (${response.status}).`), { status: response.status });
  return body as T;
}
async function upload(file: File, episodeId: string, kind: "audio" | "cover", progress: (pct: number) => void): Promise<string> {
  const types: Record<string, string> = kind === "audio"
    ? { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac" }
    : { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  const type = types[file.name.split(".").pop()?.toLowerCase() || ""] || (Object.values(types).includes(file.type) ? file.type : "");
  if (!type) throw new Error("סוג הקובץ אינו נתמך.");
  if (!file.size || file.size > 50 * 1024 * 1024) throw new Error("אפשר להעלות עד 50MB לקובץ. לקובץ גדול יותר הדביקו קישור.");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/program/upload?episode=${encodeURIComponent(episodeId)}&kind=${kind}`);
    xhr.setRequestHeader("content-type", type);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => reject(new Error("החיבור נקטע. נסו שוב."));
    xhr.onload = () => { let body: { url?: string; error?: string } = {}; try { body = JSON.parse(xhr.responseText); } catch { /* */ } if (xhr.status >= 200 && xhr.status < 300 && body.url) resolve(body.url); else reject(new Error(body.error || `ההעלאה נכשלה (${xhr.status}).`)); };
    progress(0); xhr.send(file);
  });
}

/** תמונה גדולה מוקטנת לפני ההעלאה, כדי שהאתר ייטען מהר גם בטלפון */
async function shrinkImage(file: File): Promise<File> {
  if (file.size < 700 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const x = canvas.getContext("2d"); if (!x) return file;
    x.fillStyle = "#0b0d18"; x.fillRect(0, 0, canvas.width, canvas.height); x.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

/* ---------- תמונה אוטומטית בסגנון האתר ---------- */

function wrapText(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = []; let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) { const next = line ? `${line} ${word}` : word; if (ctx.measureText(next).width > max && line) { out.push(line); line = word; } else line = next; }
  if (line) out.push(line);
  return out;
}
async function drawCover(episode: Episode, attempt: number): Promise<Blob> {
  const W = 1200, H = 828, canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const x = canvas.getContext("2d"); if (!x) throw new Error("הדפדפן לא תומך בציור תמונה.");
  const seed = [...`${episode.id}${episode.title}${attempt}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const h1 = seed % 360, h2 = (h1 + 40 + (seed % 80)) % 360, h3 = (h1 + 200) % 360;
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, `hsl(${h1} 60% 14%)`); g.addColorStop(0.55, `hsl(${h2} 55% 22%)`); g.addColorStop(1, `hsl(${h3} 60% 12%)`);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (let i = 0; i < 3; i++) { const cx = (W * ((seed >> (i * 3)) % 100)) / 100, cy = (H * ((seed >> (i * 5)) % 100)) / 100, r = x.createRadialGradient(cx, cy, 0, cx, cy, 520); r.addColorStop(0, `hsl(${[h1, h2, h3][i]} 90% 65% / .35)`); r.addColorStop(1, "transparent"); x.fillStyle = r; x.fillRect(0, 0, W, H); }
  const cx = 260, cy = H / 2 + 40;
  for (let r = 300; r > 40; r -= 6) { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.strokeStyle = r % 12 ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.08)"; x.lineWidth = 3; x.stroke(); }
  x.beginPath(); x.arc(cx, cy, 78, 0, Math.PI * 2); x.fillStyle = `hsl(${h1} 85% 62%)`; x.fill();
  for (let i = 0; i < 40; i++) { const bh = 30 + ((seed * (i + 3)) % 140); x.fillStyle = `hsl(${(h1 + i * 4) % 360} 90% 65% / .55)`; x.fillRect(W - 80 - i * 22, H - 60 - bh, 12, bh); }
  x.direction = "rtl"; x.textAlign = "right";
  x.fillStyle = "#f0c65a"; x.font = "800 30px Heebo, Arial, sans-serif"; x.fillText(`ראש בראש${episode.number != null ? `  ·  תוכנית ${episode.number}` : ""}`, W - 70, 110);
  x.fillStyle = "#fff"; x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 24;
  const title = label(episode); let size = title.length > 34 ? 84 : title.length > 22 ? 104 : 128;
  x.font = `800 ${size}px Heebo, Arial, sans-serif`;
  let lines = wrapText(x, title, W - 560); if (lines.length > 2) { size = 80; x.font = `800 ${size}px Heebo, Arial, sans-serif`; lines = wrapText(x, title, W - 560); }
  lines.slice(0, 3).forEach((line, i) => x.fillText(line, W - 70, 250 + i * size));
  x.shadowBlur = 0; x.fillStyle = "rgba(255,255,255,.85)"; x.font = "700 30px Heebo, Arial, sans-serif";
  wrapText(x, episode.description.split(/[.\n!?]/)[0].trim().slice(0, 90), W - 560).slice(0, 2).forEach((line, i) => x.fillText(line, W - 70, H - 150 + i * 42));
  x.fillStyle = "#f0c65a"; x.font = "800 26px Heebo, Arial, sans-serif"; x.fillText(fmtDate(episode.date), W - 70, H - 60);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("יצירת התמונה נכשלה."))), "image/jpeg", 0.9));
}

/* ---------- הרכיב ---------- */

export function ProgramsAdmin({ section, onMessage }: { section: ProgramSection | null; onMessage(message: string): void }) {
  const [origin, setOrigin] = useState<Catalog | null>(null);
  const [data, setData] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState("");
  const [sync, setSync] = useState<"" | "saving" | "saved" | "error">("");
  const [surveys, setSurveys] = useState<SurveyRow[]>([]);
  const [reload, setReload] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api<Record<string, unknown>>("/api/program/catalog"), api<{ draft: { data: Record<string, unknown> } | null }>("/api/program/draft").catch(() => ({ draft: null })), api<{ surveys: SurveyRow[] }>("/api/program/surveys").catch(() => ({ surveys: [] }))])
      .then(([published, { draft }, list]) => {
        if (!active) return;
        const pub = normCatalog(published);
        setOrigin(pub); setData(draft?.data ? normCatalog(draft.data) : pub); setSurveys(list.surveys || []); setLoadError("");
      })
      .catch((error) => { if (active) setLoadError(error instanceof Error ? error.message : "טעינת אתר התוכניות נכשלה."); });
    return () => { active = false; };
  }, [reload]);

  /** כל שינוי נשמר אוטומטית בטיוטה בשרת */
  const change = useCallback((next: Catalog) => {
    setData(next); setSync("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api("/api/program/draft", { method: "PUT", body: JSON.stringify({ data: next }) }).then(() => setSync("saved")).catch(() => setSync("error"));
    }, 900);
  }, []);
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

  if (!section) return null;
  if (loadError) return <section className="admin-panel"><h2>אתר התוכניות</h2><p className="panel-help">{loadError}</p><button type="button" className="prog-btn" onClick={() => { setLoadError(""); setReload((v) => v + 1); }}>ניסיון חוזר</button></section>;
  if (!data || !origin) return <section className="admin-panel"><p className="panel-help">טוענים את אתר התוכניות…</p></section>;

  const status = !changes?.any ? { cls: "ok", text: "הכול מפורסם באתר התוכניות" } : { cls: "draft", text: `יש שינויים שעדיין לא פורסמו · ${sync === "saving" ? "שומרים…" : sync === "error" ? "השמירה נכשלה, ננסה שוב בשינוי הבא" : "נשמרו בטיוטה"}` };
  const statusBar = <div className={`prog-status ${status.cls}`}><span className="dot" />{status.text}{changes?.any && section !== "publish" && <a href="#prog-publish" className="prog-status-link">לפרסום ←</a>}</div>;
  const common = { data, change, onMessage };
  return <div className="prog-admin">
    {statusBar}
    {section === "programs" && <ProgramsSection {...common} surveys={surveys} live={new Set(origin.episodes.filter((e) => e.visible).map((e) => e.id))} />}
    {section === "site" && <SiteSection {...common} />}
    {section === "listeners" && <ListenersSection data={data} onMessage={onMessage} />}
    {section === "publish" && <PublishSection {...common} origin={origin} changes={changes} onPublished={(published) => { setOrigin(published); setData(published); setSync(""); }} onDiscard={() => setReload((v) => v + 1)} />}
  </div>;
}

type Common = { data: Catalog; change(next: Catalog): void; onMessage(message: string): void };
/** מתג הפעלה/כיבוי שנראה כמו מתג */
const Switch = ({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) => <button type="button" role="switch" aria-checked={on} className={`prog-switch${on ? " on" : ""}`} onClick={onClick}><i aria-hidden="true" /><span>{children}</span></button>;
/** בחירת קובץ בעברית, במקום הכפתור האנגלי של הדפדפן */
const FilePick = ({ accept, onChange, children }: { accept: string; onChange(event: ChangeEvent<HTMLInputElement>): void; children: ReactNode }) => <label className="prog-file"><input type="file" accept={accept} onChange={onChange} /><span>{children}</span></label>;
const Section = ({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) => <section className="admin-panel prog-panel"><header className="prog-panel-head"><h2>{title}</h2>{aside}</header>{children}</section>;

/* ======================= 1. תוכניות ======================= */

function ProgramsSection({ data, change, onMessage, surveys, live }: Common & { surveys: SurveyRow[]; live: Set<string> }) {
  const [selected, setSelected] = useState<string | null>(null);
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
  const patch = (id: string, fields: Partial<Episode>) => setEpisodes(data.episodes.map((e) => (e.id === id ? { ...e, ...fields } : e)));
  const uniqueSlug = (base: string, self: string) => { const root = slugify(base); let slug = root, n = 2; while (data.episodes.some((e) => e.slug === slug && e.id !== self)) slug = `${root}-${n++}`; return slug; };

  const create = () => {
    const id = `ep-${Date.now().toString(36)}`, number = data.episodes.reduce((m, e) => Math.max(m, e.number || 0), 0) + 1;
    const episode = normEpisode({ id, slug: uniqueSlug(today(), id), number, season: data.seasons[0]?.id || "", date: today(), visible: true }, 0);
    setEpisodes([episode, ...data.episodes]); setQuery(""); setFilter("all"); setBulk(false); setSelected(id);
  };
  const duplicate = (episode: Episode) => {
    const id = `ep-${Date.now().toString(36)}`;
    setEpisodes([{ ...episode, id, slug: uniqueSlug(`${episode.slug}-2`, id), number: episode.number != null ? episode.number + 1 : null, featured: false, title: `${episode.title} (עותק)` }, ...data.episodes]);
    setSelected(id); onMessage("התוכנית שוכפלה. זה העותק — ערכו אותו.");
  };
  const removeIds = (ids: string[]) => { setEpisodes(data.episodes.filter((e) => !ids.includes(e.id))); if (selected && ids.includes(selected)) setSelected(null); setPicked(new Set()); onMessage(ids.length === 1 ? "התוכנית נמחקה מהטיוטה. עד הפרסום היא עדיין באתר." : `${ids.length} תוכניות נמחקו מהטיוטה.`); };
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
          return <button key={e.id} type="button" role="option" aria-selected={on} className={`prog-item${on ? " selected" : ""}${e.visible ? "" : " muted"}`} onClick={() => { if (bulk) { const next = new Set(picked); if (next.has(e.id)) next.delete(e.id); else next.add(e.id); setPicked(next); } else setSelected(e.id); }}>
            <i>{bulk ? (picked.has(e.id) ? "✓" : "") : e.number ?? "♫"}</i>
            <span><b>{label(e)}</b><small>{fmtDate(e.date) || "בלי תאריך"} · <em className={!e.visible ? "st-hidden" : scheduled(e) ? "st-scheduled" : "st-live"}>{!e.visible ? "מוסתרת" : scheduled(e) ? "מתוזמנת" : "מוצגת"}</em>{e.featured ? " · ★" : ""}{streamUrl(e) ? "" : " · בלי הקלטה"}</small></span>
          </button>;
        })}
        {!shown.length && <p className="panel-help">אין תוכניות שמתאימות לחיפוש.</p>}
      </div>
    </aside>
    <div className="prog-editor">
      {current ? <Editor key={current.id} episode={current} live={live.has(current.id)} data={data} surveys={surveys} onPatch={(fields) => patch(current.id, fields)} onFeatured={(on) => setEpisodes(data.episodes.map((e) => ({ ...e, featured: on && e.id === current.id })))} onDuplicate={() => duplicate(current)} onDelete={() => { if (confirm(`למחוק את "${label(current)}"?`)) removeIds([current.id]); }} onSeasons={(seasons) => change({ ...data, seasons })} uniqueSlug={uniqueSlug} onMessage={onMessage} />
        : <section className="admin-panel prog-empty"><b>♫</b><h2>בחרו תוכנית מהרשימה</h2><p className="panel-help">או לחצו „+ תוכנית חדשה”. כל שינוי נשמר מיד; כשמסיימים לוחצים „פרסום התוכניות” בתפריט.</p></section>}
    </div>
  </div>;
}

function Editor({ episode, live, data, surveys, onPatch, onFeatured, onDuplicate, onDelete, onSeasons, uniqueSlug, onMessage }: { episode: Episode; live: boolean; data: Catalog; surveys: SurveyRow[]; onPatch(fields: Partial<Episode>): void; onFeatured(on: boolean): void; onDuplicate(): void; onDelete(): void; onSeasons(seasons: Season[]): void; uniqueSlug(base: string, self: string): string; onMessage(message: string): void }) {
  const [audioStatus, setAudioStatus] = useState(""), [coverStatus, setCoverStatus] = useState("");
  const historyRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0), [history, setHistory] = useState<Array<{ version: Version; found: Episode | null }> | null>(null);
  const stream = streamUrl(episode);
  const onUpload = (kind: "audio" | "cover") => async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget, picked = input.files?.[0]; if (!picked) return;
    const file = kind === "cover" ? await shrinkImage(picked) : picked;
    const setStatus = kind === "audio" ? setAudioStatus : setCoverStatus;
    try { const url = await upload(file, episode.id, kind, (pct) => setStatus(`מעלים את ${file.name} — ${pct}%`)); onPatch(kind === "audio" ? { audio: url, duration: 0 } : { cover: url }); setStatus(""); onMessage("הקובץ הועלה. כשתפרסמו, הוא יופיע באתר."); }
    catch (error) { setStatus(error instanceof Error ? error.message : "ההעלאה נכשלה."); }
    input.value = "";
  };
  const autoCover = async () => {
    setCoverStatus("מציירים…");
    try { const blob = await drawCover(episode, attempt); const url = await upload(new File([blob], `cover-${episode.slug}.jpg`, { type: "image/jpeg" }), episode.id, "cover", (pct) => setCoverStatus(`מעלים — ${pct}%`)); setAttempt(attempt + 1); onPatch({ cover: url }); setCoverStatus(""); onMessage("התמונה נוצרה. לא אהבתם? לחצו שוב לגרסה אחרת."); }
    catch (error) { setCoverStatus(error instanceof Error ? error.message : "יצירת התמונה נכשלה."); }
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
    } catch (error) { setHistory(null); onMessage(error instanceof Error ? error.message : "טעינת הגרסאות נכשלה."); }
  };
  const newSeason = () => {
    const title = prompt("איך לקרוא לעונה החדשה? (למשל: עונת 2027)"); if (!title) return;
    const year = title.match(/\d{4}/)?.[0]; let id = slugify(year || title), n = 2; while (data.seasons.some((s) => s.id === id)) id = `${slugify(year || title)}-${n++}`;
    onSeasons([...data.seasons, { id, title: title.trim(), year: year ? Number(year) : null, note: "" }]); onPatch({ season: id });
  };

  return <>
    <Section title={label(episode)} aside={<div className="row-actions">
      {live ? <a href={`${PROGRAM_SITE}episode.html?ep=${encodeURIComponent(episode.slug)}`} target="_blank" rel="noopener">צפייה באתר ↗</a> : <button type="button" onClick={() => onMessage("התוכנית עוד לא באתר. היא תופיע אחרי „פרסום התוכניות”.")}>צפייה באתר ↗</button>}
      <button type="button" onClick={share}>טקסט לוואטסאפ</button><button type="button" onClick={onDuplicate}>שכפול</button><button type="button" onClick={() => (history ? setHistory(null) : loadHistory())}>{history ? "הסתרת הגרסאות" : "גרסאות קודמות"}</button><button type="button" className="danger" onClick={onDelete}>מחיקה</button>
    </div>}>
      <div className="prog-form">
        <label className="wide"><span>שם התוכנית</span><input value={episode.title} placeholder="למשל: שירי הסתיו" onChange={(e) => onPatch({ title: e.target.value })} /></label>
        <label><span>תאריך השידור</span><input type="date" value={episode.date} onChange={(e) => onPatch({ date: e.target.value })} /></label>
        <label><span>מספר התוכנית</span><input type="number" value={episode.number ?? ""} onChange={(e) => onPatch({ number: e.target.value === "" ? null : Number(e.target.value) })} /></label>
        <label><span>עונה</span><select value={episode.season} onChange={(e) => (e.target.value === "__new" ? newSeason() : onPatch({ season: e.target.value }))}><option value="">בלי עונה</option>{data.seasons.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}<option value="__new">+ עונה חדשה…</option></select></label>
        <label><span>אורחים</span><input value={episode.guests.join(", ")} placeholder="שמות, מופרדים בפסיק" onChange={(e) => onPatch({ guests: splitList(e.target.value) })} /></label>
        <label className="wide"><span>על התוכנית</span><textarea value={episode.description} placeholder="כמה משפטים על מה שהיה בתוכנית." onChange={(e) => onPatch({ description: e.target.value })} /></label>
        <label><span>מקושרת למצעד (לא חובה)</span><select value={episode.surveyId} onChange={(e) => onPatch({ surveyId: e.target.value })}><option value="">בלי מצעד</option>{surveys.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? " · הפעיל" : ""}{s.open ? " · ההצבעה פתוחה" : ""}</option>)}</select><small>דף התוכנית יציג קישור להצבעה כשהמצעד פתוח.</small></label>
        <label><span>פרסום מתוזמן (לא חובה)</span><input type="datetime-local" value={episode.publishAt} onChange={(e) => onPatch({ publishAt: e.target.value })} /><small>{episode.publishAt ? (scheduled(episode) ? `תופיע באתר ב־${when(episode.publishAt)}.` : "המועד עבר — מוצגת כרגיל.") : "ריק = מופיעה מיד אחרי הפרסום."}</small></label>
      </div>
      <div className="prog-switches">
        <Switch on={episode.visible} onClick={() => onPatch({ visible: !episode.visible })}>{episode.visible ? "מוצגת באתר" : "מוסתרת מהאתר"}</Switch>
        <Switch on={episode.featured} onClick={() => onFeatured(!episode.featured)}>המומלצת בדף הבית</Switch>
      </div>
      {history && <div className="prog-history" ref={historyRef}>
        <h3>גרסאות קודמות של התוכנית</h3>
        {!history.length ? <p className="panel-help">טוענים… (גרסה נשמרת בכל פרסום)</p> : <div className="admin-list">{history.map(({ version, found }) => <article key={version.id}><div><span><b>{when(version.createdAt)}</b><small>{found ? `${found.title || "בלי שם"}${found.date ? ` · ${fmtDate(found.date)}` : ""}` : "התוכנית לא הייתה קיימת"}{version.by ? ` · ${version.by}` : ""}</small></span></div>{found && <button type="button" onClick={() => { onPatch(found); setHistory(null); onMessage("התוכנית שוחזרה לטיוטה. פרסמו כדי להעלות לאתר."); }}>שחזור</button>}</article>)}</div>}
        <button type="button" className="prog-btn" onClick={() => setHistory(null)}>סגירה</button>
      </div>}
    </Section>

    <Section title="ההקלטה" aside={episode.duration ? <strong className="prog-badge">{fmtDuration(episode.duration)}</strong> : undefined}>
      <p className={`prog-note ${stream ? "ok" : ""}`}>{stream ? "✓ יש הקלטה לתוכנית הזו. המאזינים שומעים אותה בנגן של האתר." : "עדיין אין הקלטה. העלו קובץ או הדביקו קישור."}</p>
      {stream && <audio className="prog-audio" controls preload="metadata" src={stream} onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (!episode.duration && Number.isFinite(d)) onPatch({ duration: Math.round(d) }); }} />}
      <div className="prog-form">
        <div className="prog-field"><span>{stream ? "החלפת ההקלטה" : "העלאת ההקלטה"}</span><FilePick accept=".mp3,.m4a,.wav,.ogg,.flac,.aac" onChange={onUpload("audio")}>⬆ בחירת קובץ הקלטה מהמחשב</FilePick><small>{audioStatus || "קובץ שמע עד 50MB. לקובץ גדול יותר — הדביקו קישור."}</small></div>
        <label><span>או קישור להקלטה</span><input dir="ltr" value={episode.audio} placeholder="https://…" onChange={(e) => onPatch({ audio: e.target.value, duration: 0 })} /><small>קישור שיתוף לקובץ בדרייב מספיק.</small></label>
      </div>
    </Section>

    <Section title="התמונה">
      <div className="prog-cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {episode.cover ? <img src={episode.cover} alt="" /> : <div className="prog-cover-empty">♫<small>בלי תמונה האתר מציג עטיפה צבעונית משלו</small></div>}
        <div className="prog-form single">
          <div className="prog-field"><span>יצירת תמונה אוטומטית</span><button type="button" className="prog-primary" onClick={autoCover}>{episode.cover ? "יצירת תמונה חדשה" : "ליצור תמונה עכשיו"}</button><small>{coverStatus || "עטיפה בסגנון האתר עם שם התוכנית, המספר ומשפט מהתיאור."}</small></div>
          <div className="prog-field"><span>או תמונה משלכם</span><FilePick accept=".jpg,.jpeg,.png,.webp" onChange={onUpload("cover")}>⬆ בחירת תמונה מהמחשב</FilePick></div>
          <label><span>או קישור לתמונה</span><input dir="ltr" value={episode.cover} placeholder="https://…" onChange={(e) => onPatch({ cover: e.target.value })} /></label>
          {episode.cover && <button type="button" className="danger" onClick={() => onPatch({ cover: "" })}>הסרת התמונה</button>}
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
  </>;
}

/* ======================= 2. הודעה ועדכונים ======================= */

function SiteSection({ data, change, onMessage }: Common) {
  const banner = data.settings.banner, updates = data.settings.updates;
  const setBanner = (fields: Partial<Banner>) => change({ ...data, settings: { ...data.settings, banner: { ...banner, ...fields } } });
  const setUpdates = (next: Update[]) => change({ ...data, settings: { ...data.settings, updates: next } });
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

    <Section title="עונות" aside={<strong className="prog-badge">{data.seasons.length}</strong>}>
      <p className="panel-help">עונה היא קבוצה של תוכניות — לפי שנה, תקופה או מגישים. בארכיון אפשר לסנן לפי עונה. מחיקת עונה לא מוחקת תוכניות.</p>
      <div className="prog-seasons">{data.seasons.map((s, i) => <div key={s.id}><input value={s.title} placeholder="שם העונה" onChange={(e) => setSeason(i, { title: e.target.value })} /><input type="number" value={s.year ?? ""} placeholder="שנה" onChange={(e) => setSeason(i, { year: e.target.value ? Number(e.target.value) : null })} /><input value={s.note} placeholder="הערה" onChange={(e) => setSeason(i, { note: e.target.value })} /><small>{counts[s.id] || 0} תוכניות</small><button type="button" className="danger" onClick={() => { if (confirm(`למחוק את העונה "${s.title}"?`)) change({ ...data, seasons: data.seasons.filter((_, j) => j !== i), episodes: data.episodes.map((e) => (e.season === s.id ? { ...e, season: "" } : e)) }); }}>✕</button></div>)}</div>
      <button type="button" className="prog-btn" onClick={() => { const y = new Date().getFullYear(); let id = String(y), n = 2; while (data.seasons.some((s) => s.id === id)) id = `${y}-${n++}`; change({ ...data, seasons: [...data.seasons, { id, title: `עונת ${y}`, year: y, note: "" }] }); }}>+ עונה חדשה</button>
    </Section>
  </>;
}

/* ======================= 3. מאזינים ======================= */

function ListenersSection({ data, onMessage }: { data: Catalog; onMessage(message: string): void }) {
  const [stats, setStats] = useState<Stats | null>(null), [messages, setMessages] = useState<{ messages: Message[]; unread: number } | null>(null), [subs, setSubs] = useState<{ active: number; fromProgram: number } | null>(null);
  const [error, setError] = useState(""), [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([api<Stats>("/api/program/stats"), api<{ messages: Message[]; unread: number }>("/api/program/messages"), api<{ active: number; fromProgram: number }>("/api/program/subscribers/count").catch(() => null)])
      .then(([s, m, c]) => { if (active) { setStats(s); setMessages(m); setSubs(c); setError(""); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "הטעינה נכשלה."); });
    return () => { active = false; };
  }, [tick]);
  const name = (id: string | null) => { const e = data.episodes.find((x) => x.id === id); return e ? label(e) : "תוכנית שנמחקה"; };
  const act = async (path: string, init: RequestInit) => { try { await api(path, init); setTick((v) => v + 1); } catch (cause) { onMessage(cause instanceof Error ? cause.message : "הפעולה נכשלה."); } };
  if (error) return <Section title="מאזינים"><p className="panel-help">{error}</p></Section>;
  if (!stats || !messages) return <Section title="מאזינים"><p className="panel-help">טוענים…</p></Section>;
  const max = Math.max(1, ...stats.days.map((d) => Number(d.plays) || 0));
  return <>
    <Section title="מי מאזין" aside={<button type="button" className="prog-btn" onClick={() => { setTick((v) => v + 1); onMessage("המספרים עודכנו."); }}>↻ רענון</button>}>
      <div className="stat-grid prog-stats"><article><small>האזנות בשבוע האחרון</small><b>{n2(stats.week.plays)}</b></article><article><small>מאזינים בשבוע האחרון</small><b>{n2(stats.week.listeners)}</b></article><article><small>האזנות מאז ההתחלה</small><b>{n2(stats.totals.plays)}</b></article><article><small>שעות האזנה</small><b>{n2(Math.round((Number(stats.totals.seconds) || 0) / 3600))}</b></article></div>
      <h3>30 הימים האחרונים</h3>
      {stats.days.length ? <div className="prog-bars">{stats.days.map((d) => <div key={d.day} title={`${fmtDate(d.day)}: ${n2(d.plays)} האזנות`}><i style={{ height: `${Math.round(((Number(d.plays) || 0) / max) * 100)}%` }} /><small>{d.day.slice(8)}</small></div>)}</div> : <p className="panel-help">עדיין אין האזנות שנרשמו.</p>}
      <div className="prog-two">
        <div><h3>הכי נשמעות החודש</h3><ol className="prog-top">{stats.recent.slice(0, 10).map((r) => <li key={r.id}><span>{name(r.id)}</span><b>{n2(r.plays)}</b></li>)}</ol></div>
        <div><h3>הכי נשמעות מאז ומעולם</h3><ol className="prog-top">{stats.episodes.slice(0, 10).map((r) => <li key={r.id}><span>{name(r.id)}</span><b>{n2(r.plays)}</b></li>)}</ol></div>
      </div>
      <p className="panel-help">מכשירים החודש: טלפון {n2(stats.devices.phone)} · מחשב {n2(stats.devices.desktop)}. הספירה אנונימית.</p>
    </Section>
    <Section title="הודעות מהמאזינים" aside={messages.unread ? <strong className="prog-badge warn">{messages.unread} חדשות</strong> : undefined}>
      {messages.messages.length ? <div className="prog-messages">{messages.messages.map((m) => <article key={m.id} className={m.readAt ? "" : "unread"}>
        <header><b>{m.name || "מאזין/ה"}</b>{m.email && <a href={`mailto:${m.email}`}>{m.email}</a>}<small>{when(m.createdAt)}{m.episodeId ? ` · על "${name(m.episodeId)}"` : ""}</small></header>
        <p>{m.text}</p>
        <div className="row-actions"><button type="button" onClick={() => act("/api/program/messages/read", { method: "POST", body: JSON.stringify({ id: m.id, read: !m.readAt }) })}>{m.readAt ? "סימון כלא נקרא" : "✓ נקרא"}</button>{m.email && <a href={`mailto:${m.email}?subject=${encodeURIComponent("תשובה מראש בראש")}`}>תשובה במייל</a>}<button type="button" className="danger" onClick={() => { if (confirm("למחוק את ההודעה?")) act("/api/program/messages", { method: "DELETE", body: JSON.stringify({ id: m.id }) }); }}>מחיקה</button></div>
      </article>)}</div> : <p className="panel-help">עדיין לא הגיעו הודעות. המאזינים כותבים דרך „כתבו לנו” באתר התוכניות.</p>}
    </Section>
    {subs && <Section title="רשימת התפוצה"><p className="panel-help">{n2(subs.active)} נרשמים פעילים, מהם {n2(subs.fromProgram)} דרך אתר התוכניות. הרשימה המלאה בלשונית „רשימת תפוצה”.</p></Section>}
  </>;
}

/* ======================= 4. פרסום ======================= */

type Changes = { added: number; changed: number; removed: Episode[]; seasons: boolean; settings: boolean; any: boolean } | null;

function PublishSection({ data, change, onMessage, origin, changes, onPublished, onDiscard }: Common & { origin: Catalog; changes: Changes; onPublished(published: Catalog): void; onDiscard(): void }) {
  const [busy, setBusy] = useState(false), [versions, setVersions] = useState<Version[] | null>(null), [preview, setPreview] = useState("");
  const [checks, setChecks] = useState<Record<string, { running: boolean; done: number; total: number; problems: Array<{ id: string; text: string }> }>>({});
  const [migrate, setMigrate] = useState<{ running: boolean; done: number; total: number; moved: number; had: number; failed: string[] } | null>(null);
  const stopMigrate = useRef(false), fileInput = useRef<HTMLInputElement>(null);

  const health = useMemo(() => {
    const must: Array<{ id: string; text: string }> = [], should: Array<{ id: string; text: string }> = [], dup: string[] = [];
    const byNumber = new Map<number, Episode[]>(), byDrive = new Map<string, Episode[]>();
    for (const e of data.episodes) {
      if (!e.title.trim()) must.push({ id: e.id, text: `תוכנית בלי שם${e.number != null ? ` (תוכנית ${e.number})` : ""}` });
      if (!streamUrl(e)) should.push({ id: e.id, text: `"${label(e)}" בלי הקלטה` });
      if (!e.cover) should.push({ id: e.id, text: `"${label(e)}" בלי תמונה` });
      if (!e.date) should.push({ id: e.id, text: `"${label(e)}" בלי תאריך` });
      if (e.number != null) byNumber.set(e.number, [...(byNumber.get(e.number) || []), e]);
      const d = driveId(e); if (d) byDrive.set(d, [...(byDrive.get(d) || []), e]);
    }
    for (const [n, l] of byNumber) if (l.length > 1) dup.push(`${l.length} תוכניות עם המספר ${n}: ${l.map(label).join(", ")}`);
    for (const [, l] of byDrive) if (l.length > 1) dup.push(`אותה הקלטה ב־${l.length} תוכניות: ${l.map(label).join(", ")}`);
    const groups = [
      { key: "audio", title: "תוכניות בלי הקלטה", hint: "המאזינים לא יוכלו לשמוע אותן", items: data.episodes.filter((e) => !streamUrl(e)) },
      { key: "date", title: "תוכניות בלי תאריך", hint: "הן יופיעו בסוף הארכיון", items: data.episodes.filter((e) => !e.date) },
      { key: "cover", title: "תוכניות בלי תמונה", hint: "האתר מציג להן עטיפה צבעונית; אפשר ליצור תמונה בלחיצה", items: data.episodes.filter((e) => !e.cover) },
    ].filter((g) => g.items.length);
    return { must, should, dup, groups };
  }, [data.episodes]);

  const publish = async () => {
    if (health.must.length) return onMessage(health.must[0].text);
    setBusy(true); onMessage("מפרסמים…");
    try {
      const removedIds = origin.episodes.filter((o) => !data.episodes.some((e) => e.id === o.id)).map((o) => o.id);
      await api("/api/program/catalog", { method: "POST", body: JSON.stringify({ seasons: data.seasons, episodes: data.episodes.map((e) => normEpisode(e, 0)), removedIds, settings: data.settings }) });
      onPublished(normCatalog(JSON.parse(JSON.stringify(data)))); setVersions(null); onMessage("פורסם! אתר התוכניות מציג עכשיו את הגרסה החדשה.");
    } catch (error) { onMessage(error instanceof Error ? error.message : "הפרסום נכשל."); }
    finally { setBusy(false); }
  };
  const discard = async () => { if (!confirm("לבטל את כל השינויים שלא פורסמו?")) return; try { await api("/api/program/draft", { method: "DELETE" }); onDiscard(); onMessage("השינויים בוטלו."); } catch (error) { onMessage(error instanceof Error ? error.message : "הביטול נכשל."); } };
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
  const loadVersions = async () => { try { setVersions((await api<{ versions: Version[] }>("/api/program/versions")).versions); } catch (error) { onMessage(error instanceof Error ? error.message : "הטעינה נכשלה."); } };
  const restoreVersion = async (version: Version) => {
    if (!confirm(`לשחזר את הגרסה מ־${when(version.createdAt)}? כל מה שבטיוטה יוחלף. אחר כך מפרסמים.`)) return;
    try { const { data: snapshot } = await api<{ data: Record<string, unknown> }>(`/api/program/versions/${version.id}`); const restored = normCatalog(snapshot); change(snapshot.settings ? restored : { ...restored, settings: data.settings }); onMessage("הגרסה שוחזרה לטיוטה. בדקו ופרסמו."); }
    catch (error) { onMessage(error instanceof Error ? error.message : "השחזור נכשל."); }
  };
  const makePreview = async () => { try { await api("/api/program/draft", { method: "PUT", body: JSON.stringify({ data }) }); const { preview: p } = await api<{ preview: { token: string } }>("/api/program/preview", { method: "POST" }); setPreview(`${PROGRAM_SITE}index.html?preview=${p.token}`); } catch (error) { onMessage(error instanceof Error ? error.message : "יצירת הקישור נכשלה."); } };
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
      catch (error) { state.failed.push(`${label(e)}: ${error instanceof Error ? error.message : "נכשל"}`); }
      state.done++; setMigrate({ ...state, failed: [...state.failed] });
    }
    setMigrate({ ...state, running: false, failed: [...state.failed] });
  };

  const list: string[] = [];
  if (changes?.added) list.push(changes.added === 1 ? "תוכנית אחת חדשה" : `${changes.added} תוכניות חדשות`);
  if (changes?.changed) list.push(changes.changed === 1 ? "תוכנית אחת עודכנה" : `${changes.changed} תוכניות עודכנו`);
  if (changes?.removed.length) list.push(changes.removed.length === 1 ? `תוכנית אחת תימחק מהאתר (${label(changes.removed[0])})` : `${changes.removed.length} תוכניות יימחקו מהאתר`);
  if (changes?.seasons) list.push("העונות השתנו");
  if (changes?.settings) list.push("ההודעה או העדכונים השתנו");
  const check = (kind: "audio" | "media", title: string, hint: string) => { const r = checks[kind]; return <article><div><span><b>{title}</b><small>{r ? (r.running ? `בודקים… ${r.done}/${r.total}` : r.problems.length ? `${r.problems.length} בעיות:` : `✓ הכול תקין (${r.total} נבדקו)`) : hint}</small>{r && !r.running && !!r.problems.length && <ul className="prog-problems">{r.problems.map((p, i) => <li key={i}>{p.text}</li>)}</ul>}</span></div><button type="button" className="prog-btn" disabled={r?.running} onClick={() => runCheck(kind)}>{r?.running ? "בודקים…" : r ? "↻ בדיקה חוזרת" : "▶ להתחיל בדיקה"}</button></article>; };

  return <>
    <Section title={changes?.any ? "יש שינויים שמחכים לפרסום" : "הכול מפורסם"}>
      <p className="panel-help">{changes?.any ? "עד הפרסום, השינויים נראים רק כאן (ולמי שקיבל קישור תצוגה מקדימה)." : "אתר התוכניות מציג בדיוק את מה שיש כאן."}</p>
      {!!list.length && <ul className="prog-changes">{list.map((x) => <li key={x}>{x}</li>)}</ul>}
      {!!health.must.length && <div className="prog-must"><b>לפני שמפרסמים, צריך לתקן:</b><ul>{health.must.map((p) => <li key={p.id}>{p.text}</li>)}</ul></div>}
      <div className="row-actions">{changes?.any ? <><button type="button" className="prog-primary big" disabled={!!health.must.length || busy} onClick={publish}>{busy ? "מפרסמים…" : "פרסום לאתר התוכניות ←"}</button><button type="button" onClick={discard}>ביטול כל השינויים</button></> : <span className="prog-done">✓ אין שינויים שמחכים לפרסום</span>}</div>
    </Section>

    <Section title="בדיקת תקינות" aside={<strong className="prog-badge">{health.groups.length + health.dup.length ? `${health.groups.length + health.dup.length} נושאים` : "✓ תקין"}</strong>}>
      {health.dup.length > 0 && <div className="prog-must soft"><b>כפילויות:</b><ul>{health.dup.map((d) => <li key={d}>{d}</li>)}</ul></div>}
      {health.groups.length ? <><div className="prog-groups">{health.groups.map((g) => <details key={g.key}><summary><b>{g.items.length}</b><span>{g.title}</span><small>{g.hint}</small></summary><ul className="prog-problems">{g.items.map((e) => <li key={e.id}>{label(e)}</li>)}</ul></details>)}</div><p className="panel-help">אלה הצעות בלבד — הן לא חוסמות פרסום. לחיצה על שורה מציגה את התוכניות.</p></> : <p className="panel-help">✓ לכל התוכניות יש שם, תאריך, הקלטה ותמונה.</p>}
      <div className="admin-list">{check("audio", "בדיקת ההקלטות", "עובר על כל ההקלטות ומוודא שהן נטענות בנגן.")}{check("media", "בדיקת תמונות וקישורים", "מוודא שהתמונות נטענות ושהקישורים עונים.")}</div>
    </Section>

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

