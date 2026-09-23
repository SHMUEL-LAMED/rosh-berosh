/* הליבה של ניהול אתר התוכניות: הטיפוסים, הנרמול, העזרים, הפנייה ל־API
   (/api/program/*), ההעלאה בחלקים ל־R2, ציור העטיפה והתמונה הקטנה. בלי
   React — כדי שכל חלקי הניהול (תוכניות, AI, מאזינים, עבודות) ישתמשו באותם
   כלים בדיוק, ובאותם שמות שדות כמו הניהול העצמאי של אתר התוכניות. */

import { useSyncExternalStore } from "react";

export const PROGRAM_SITE = "https://shmuel-lamed.github.io/rosh-berosh-2/";

export type Link = { label: string; url: string };
export type Episode = {
  id: string; slug: string; number: number | null; season: string; title: string; date: string; description: string;
  cover: string; thumb: string; audio: string; duration: number; tags: string[]; guests: string[]; links: Link[];
  featured: boolean; visible: boolean; publishAt: string; surveyId: string; [key: string]: unknown;
};
export type Season = { id: string; title: string; year: number | null; note: string };
export type Banner = { enabled: boolean; text: string; link: string; linkLabel: string; until: string; sites: { program: boolean; survey: boolean } };
export type Update = { id: string; date: string; title: string; text: string; link: string; pinned: boolean };
/** פרטי הקשר שבדף הבית של אתר התוכניות — אותם שישה שדות כמו בשרת (normalizeContacts) */
export const DEFAULT_CONTACTS = {
  phone: "077-226-2271",
  phone2: "073-707-9536",
  email: "rbr17011701@gmail.com",
  phoneNote: "האזנה לתוכניות בשלוחה 1, שירים מומלצים בשלוחה 3 והרשמה לצינתוק בשלוחה 4.",
  hostsNote: "לשאלות ולתגובות למגישים: שלוחה 9 בקו התוכן. פורום המאזינים נמצא בשלוחה 5.",
  chatNote: "בבקשה ציינו לאיזו קבוצה להצטרף — גברים או נשים.",
};
export type Contacts = typeof DEFAULT_CONTACTS;
export type Settings = { banner: Banner; updates: Update[]; contacts: Contacts };
export type Catalog = { seasons: Season[]; episodes: Episode[]; settings: Settings };
export type SurveyRow = { id: string; name: string; active: boolean; open: boolean };
export type Version = { id: string; by: string; episodes: number; createdAt: number };
export type Message = { id: string; name: string; email: string; text: string; episodeId: string | null; readAt: number | null; createdAt: number };
export type Stats = {
  days: Array<{ day: string; plays: number; listeners: number }>; episodes: Array<{ id: string; plays: number }>; recent: Array<{ id: string; plays: number }>;
  totals: { plays?: number; seconds?: number }; week: { plays?: number; listeners?: number }; devices: Record<string, number>;
  sources?: Array<{ ref: string; plays: number }>; hours?: Array<{ hour: number; plays: number }>; likes?: Array<{ id: string; likes: number }>; moments?: Array<{ id: string; count: number }>;
};
export type EpisodeStats = { plays: number; listeners: number; retention: Array<{ pct: number; listeners: number }> };
export type Moments = { id: string; total: number; buckets: Array<{ at: number; count: number }>; top: Array<{ at: number; count: number }> };
export type Comment = { id: string; episodeId: string; name: string; email: string; text: string; at: number | null; status: "pending" | "approved" | "hidden"; pinned: boolean; reply: string | null; replyBy: string | null; createdAt: number };
export type AiSummary = { description: string; summary: string; tags: string[]; guests: string[]; model?: string; createdAt?: string };
export type Transcript = { text: string; partsDone: number; partsTotal: number; summary: AiSummary | null; updatedAt: string | null; automatic?: { attempts: number; error: string | null; nextAt: number } | null };
export type ProofResult = { key: string; fixed: string; changes: Array<{ from: string; to: string }>; original: string; applied?: boolean; ignored?: boolean; stale?: boolean };

/* ---------- עזרים ---------- */

export const str = (value: unknown) => (value == null ? "" : String(value));
export const list = (value: unknown) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
export const today = () => new Date().toISOString().slice(0, 10);
export const label = (episode: Episode) => episode.title.trim() || "תוכנית בלי שם";
export const n2 = (value: unknown) => Number(value || 0).toLocaleString("he-IL");
export const splitList = (value: string) => value.split(/[,،]/).map((item) => item.trim()).filter(Boolean);
export const uniq = (items: unknown[]) => [...new Set(items.map((x) => String(x ?? "").trim()).filter(Boolean))];
export const when = (value: number | string) => new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(typeof value === "number" ? value * 1000 : value));
export const fmtDate = (iso: string) => { if (!iso) return ""; const date = new Date(`${iso.slice(0, 10)}T12:00:00`); return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", year: "numeric" }).format(date); };
export const fmtDuration = (seconds: number) => { if (!seconds) return ""; const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60); return h ? `${h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`}${m ? ` ו־${m} דקות` : ""}` : `${m} דקות`; };
/** רגע בתוכנית: 1:05:09 או 5:09 */
export const fmtTime = (seconds: number) => { const s = Math.max(0, Math.floor(Number(seconds) || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
export const slugify = (value: string) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "episode";
export const scheduled = (episode: Episode) => !!episode.publishAt && new Date(episode.publishAt) > new Date();
/** תיאור כללי שאינו מספר מה היה בתוכנית (כמו בתוכניות שיובאו מהארכיון) */
export const GENERIC_DESC = /^(מתוך ארכיון תוכנית ראש בראש\.?|הקלטה משוחזרת מתקופת קו המכלול[^]*)$/;
export const hasRealDescription = (episode: Episode) => !!episode.description.trim() && !GENERIC_DESC.test(episode.description.trim());

export function normEpisode(raw: Record<string, unknown>, index: number): Episode {
  const links = Array.isArray(raw.links) ? (raw.links as Array<Record<string, unknown>>).filter((l) => l && l.url).map((l) => ({ label: str(l.label || l.url), url: str(l.url) })) : [];
  return {
    ...raw,
    id: str(raw.id || raw.slug || `ep-${index}`), slug: str(raw.slug || raw.id || `ep-${index}`),
    number: raw.number == null || raw.number === "" ? null : Number(raw.number), season: str(raw.season), title: str(raw.title),
    date: str(raw.date).slice(0, 10), description: str(raw.description), cover: str(raw.cover), thumb: str(raw.thumb), audio: str(raw.audio), duration: Number(raw.duration) || 0,
    tags: list(raw.tags), guests: list(raw.guests), links, featured: !!raw.featured, visible: raw.visible !== false,
    publishAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str(raw.publishAt)) ? str(raw.publishAt).slice(0, 16) : "", surveyId: str(raw.surveyId),
  };
}
export function normContacts(raw: unknown): Contacts {
  const c = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const field = (key: keyof Contacts) => (c[key] === undefined || c[key] === null ? DEFAULT_CONTACTS[key] : str(c[key]).trim());
  return { phone: field("phone"), phone2: field("phone2"), email: field("email"), phoneNote: field("phoneNote"), hostsNote: field("hostsNote"), chatNote: field("chatNote") };
}
export function normCatalog(raw: Record<string, unknown> | null | undefined): Catalog {
  const seasons = (Array.isArray(raw?.seasons) ? raw.seasons as Array<Record<string, unknown>> : []).map((s, i) => ({ id: str(s.id || `s${i + 1}`), title: str(s.title || `עונה ${i + 1}`), year: s.year ? Number(s.year) : null, note: str(s.note) }));
  const episodes = (Array.isArray(raw?.episodes) ? raw.episodes as Array<Record<string, unknown>> : []).map(normEpisode);
  const settings = (raw?.settings && typeof raw.settings === "object" ? raw.settings : {}) as Record<string, unknown>;
  const b = (settings.banner && typeof settings.banner === "object" ? settings.banner : {}) as Record<string, unknown>;
  const sites = (b.sites && typeof b.sites === "object" ? b.sites : {}) as Record<string, unknown>;
  const banner: Banner = { enabled: !!b.enabled, text: str(b.text), link: str(b.link), linkLabel: str(b.linkLabel), until: str(b.until).slice(0, 10), sites: { program: sites.program !== false, survey: sites.survey === true } };
  const updates = (Array.isArray(settings.updates) ? settings.updates as Array<Record<string, unknown>> : []).map((u, i) => ({ id: str(u.id || `u${i}`), date: str(u.date).slice(0, 10), title: str(u.title), text: str(u.text), link: str(u.link), pinned: !!u.pinned }));
  return { seasons, episodes, settings: { banner, updates, contacts: normContacts(settings.contacts) } };
}
/** מה שנשמר ומתפרסם — בלי שדות מחושבים, כדי שההשוואה תהיה נקייה */
export const pack = (episode: Episode) => JSON.stringify(normEpisode(episode, 0));

export function driveId(episode: Episode): string | null {
  for (const value of [episode.audio, ...episode.links.map((l) => l.url)]) {
    try { const u = new URL(value); if (u.protocol === "https:" && u.hostname === "drive.google.com") { const id = u.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1] || u.searchParams.get("id"); if (id && /^[\w-]+$/.test(id)) return id; } }
    catch { /* not a URL */ }
  }
  return null;
}
/** מה הנגן מנגן: הזרמה דרך השרת לקובצי דרייב, אחרת הקובץ עצמו */
export function streamUrl(episode: Episode): string {
  const id = driveId(episode);
  if (id) return `/api/program/stream/${encodeURIComponent(id)}`;
  try { const u = new URL(episode.audio); return u.protocol === "https:" || u.protocol === "http:" ? episode.audio : ""; } catch { return ""; }
}

/* ---------- API ---------- */

export type ApiError = Error & { status: number; conflict?: boolean; latest?: { id: string; by: string | null; createdAt: number } | null };
export const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** בקשה לשרת עם עוגיית הכניסה של דף הניהול; שגיאה נושאת את הסטטוס ואת גוף התשובה (למשל conflict בפרסום) */
export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(str(body.error) || `הפעולה נכשלה (${response.status}).`), { status: response.status, conflict: body.conflict === true, latest: (body.latest as ApiError["latest"]) ?? null }) as ApiError;
  return body as T;
}

/* ---------- העלאת קבצים: קובץ קטן בבקשה אחת, גדול בחלקים של 20MB (R2 multipart) ---------- */

const UPLOAD_SMALL = 40 * 1024 * 1024;
const UPLOAD_MAX = { audio: 1024 * 1024 * 1024, cover: 15 * 1024 * 1024 };
const uploadTypes = (kind: "audio" | "cover"): Record<string, string> => kind === "audio"
  ? { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac" }
  : { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** בקשת XHR אחת עם דיווח התקדמות (fetch עדיין לא מדווח על העלאה) */
function send<T>(method: string, url: string, body: Blob, contentType: string, onProgress?: (loaded: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("content-type", contentType);
    if (onProgress) xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded); };
    xhr.onerror = () => reject(new Error("החיבור נקטע."));
    xhr.onload = () => {
      let json: { error?: string } = {}; try { json = JSON.parse(xhr.responseText); } catch { /* server error */ }
      if (xhr.status < 200 || xhr.status >= 300) return reject(Object.assign(new Error(json.error || `ההעלאה נכשלה (${xhr.status}).`), { status: xhr.status }));
      resolve(json as T);
    };
    xhr.send(body);
  });
}

export async function uploadFile(file: File, episodeId: string, kind: "audio" | "cover", progress: (pct: number) => void = () => {}): Promise<string> {
  const types = uploadTypes(kind);
  const contentType = types[file.name.split(".").pop()?.toLowerCase() || ""] || (file.type && Object.values(types).includes(file.type) ? file.type : "");
  if (!contentType) throw new Error("סוג הקובץ אינו נתמך.");
  if (!file.size) throw new Error("הקובץ ריק.");
  if (file.size > UPLOAD_MAX[kind]) throw new Error(kind === "audio" ? "אפשר להעלות הקלטה של עד 1GB." : "אפשר להעלות תמונה של עד 15MB.");
  const q = `episode=${encodeURIComponent(episodeId)}&kind=${kind}`;
  progress(0);
  if (file.size <= UPLOAD_SMALL) {
    const r = await send<{ url: string }>("POST", `/api/program/upload?${q}`, file, contentType, (n) => progress(Math.round((n / file.size) * 100)));
    progress(100);
    return r.url;
  }
  // העלאה בחלקים: start → part (PUT לכל חלק) → complete, או abort בכישלון
  const start = await api<{ key: string; uploadId: string; partSize?: number }>(`/api/program/upload/start?${q}`, { method: "POST", body: JSON.stringify({ contentType, size: file.size, name: file.name }) });
  const size = start.partSize || 20 * 1024 * 1024;
  const count = Math.ceil(file.size / size);
  const parts: Array<{ part: number; etag: string }> = [];
  let done = 0;
  try {
    for (let i = 0; i < count; i++) {
      const chunk = file.slice(i * size, Math.min(file.size, (i + 1) * size));
      const url = `/api/program/upload/part?key=${encodeURIComponent(start.key)}&uploadId=${encodeURIComponent(start.uploadId)}&part=${i + 1}`;
      let r: { etag: string } | null = null, attempt = 0;
      for (;;) {
        try { r = await send<{ etag: string }>("PUT", url, chunk, "application/octet-stream", (n) => progress(Math.min(99, Math.round(((done + n) / file.size) * 100)))); break; }
        catch (error) { if (++attempt >= 3 || (error as { status?: number }).status === 403) throw error; await new Promise((res) => setTimeout(res, 1500 * attempt)); }
      }
      parts.push({ part: i + 1, etag: r!.etag });
      done += chunk.size;
      progress(Math.min(99, Math.round((done / file.size) * 100)));
    }
    const r = await api<{ url: string }>("/api/program/upload/complete", { method: "POST", body: JSON.stringify({ key: start.key, uploadId: start.uploadId, parts }) });
    progress(100);
    return r.url;
  } catch (error) {
    api("/api/program/upload/abort", { method: "POST", body: JSON.stringify({ key: start.key, uploadId: start.uploadId }) }).catch(() => {});
    throw new Error(`${errorText(error, "ההעלאה נכשלה.")} בחרו שוב את הקובץ כדי לנסות מחדש.`);
  }
}

/** סוג הקובץ שנגרר לטופס: הקלטה, תמונה, או לא מזה ולא מזה */
export const fileKind = (file: File): "audio" | "cover" | "" => (/^audio\//.test(file.type) || /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(file.name) ? "audio" : /^image\//.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name) ? "cover" : "");

/** תמונה גדולה מוקטנת לפני ההעלאה, כדי שהאתר ייטען מהר גם בטלפון */
export async function shrinkImage(file: File): Promise<File> {
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
/* ---------- תמונה קטנה לכרטיסים: 640 פיקסלים, שהארכיון ודף הבית טוענים במקום התמונה המלאה ---------- */
export async function makeThumb(source: Blob | string, max = 640): Promise<Blob> {
  const blob = source instanceof Blob ? source : await (await fetch(source, { mode: "cors", cache: "no-store" })).blob();
  const img = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  const x = canvas.getContext("2d"); if (!x) throw new Error("הדפדפן לא תומך בציור תמונה.");
  x.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("יצירת התמונה הקטנה נכשלה."))), "image/jpeg", 0.82));
}
/** מעלה תמונה (ואת הגרסה הקטנה שלה) ומחזיר את שתי הכתובות לשמירה בתוכנית */
export async function setCover(episode: Episode, blob: Blob, progress: (pct: number) => void = () => {}): Promise<{ cover: string; thumb: string }> {
  const name = `cover-${episode.slug || episode.id}`;
  const cover = await uploadFile(new File([blob], `${name}.jpg`, { type: blob.type || "image/jpeg" }), episode.id, "cover", progress);
  let thumb = "";
  try { thumb = await uploadFile(new File([await makeThumb(blob)], `${name}-small.jpg`, { type: "image/jpeg" }), episode.id, "cover"); }
  catch { thumb = ""; }   // בלי גרסה קטנה — הכרטיס יציג את התמונה המלאה
  return { cover, thumb };
}

/* ---------- תמונה אוטומטית בסגנון האתר ---------- */

function wrapText(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = []; let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) { const next = line ? `${line} ${word}` : word; if (ctx.measureText(next).width > max && line) { out.push(line); line = word; } else line = next; }
  if (line) out.push(line);
  return out;
}
export async function drawCover(episode: Episode, attempt: number): Promise<Blob> {
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

/** האורך של הקלטה, מתוך הקובץ עצמו (נקרא רק ראש הקובץ) */
export function measureDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = new Audio(); a.preload = "metadata";
    const t = setTimeout(() => { a.src = ""; reject(new Error("timeout")); }, 30000);
    a.onloadedmetadata = () => { clearTimeout(t); const d = a.duration; a.src = ""; if (Number.isFinite(d) && d > 0) resolve(Math.round(d)); else reject(new Error("no duration")); };
    a.onerror = () => { clearTimeout(t); reject(new Error("load error")); };
    a.src = url;
  });
}

/** ההתראות נשלחות במנות קטנות (מגבלת השרת); הדף ממשיך לבקש עד שכולן יצאו. מחזיר כמה נשלחו. */
export async function drainPush(sent = 0): Promise<number> {
  for (let i = 0; i < 500; i++) {
    let r: { sent?: number; remaining?: number };
    try { r = await api("/api/program/push/drain", { method: "POST" }); } catch { break; }
    sent += Number(r.sent) || 0;
    if (!Number(r.remaining)) break;
  }
  return sent;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/* ---------- מצב שחי מחוץ לרכיבים ----------
   תמלול או עבודה על הרבה תוכניות ממשיכים לרוץ גם כשעוברים לתוכנית אחרת או
   לחלק אחר של הניהול; המצב שלהם נשמר כאן, והרכיבים מאזינים לו. */
export function createMapStore<T extends object>() {
  const entries = new Map<string, T>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  return {
    get: (id: string) => entries.get(id),
    set(id: string, patch: Partial<T>) { entries.set(id, { ...(entries.get(id) || {}), ...patch } as T); emit(); },
    /** hook: הרשומה של המזהה, מתעדכנת בכל שינוי */
    useEntry(id: string): T | undefined { return useSyncExternalStore(subscribe, () => entries.get(id), () => undefined); },
  };
}
