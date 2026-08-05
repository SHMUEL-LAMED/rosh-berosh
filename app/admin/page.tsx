"use client";

import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { LoginScreen, logout, useCurrentUser } from "../auth-ui";
import { blobToWav, fromDirectory, fromZip, splitAlbumFiles, suggestChorus, type UploadFile } from "./upload-utils";
import { downloadResultsXlsx } from "./xlsx-export";

type Album = { id: string; title: string; artistName: string; coverUrl?: string; position: number; active: number };
type Song = { id: string; albumId: string; title: string; audioUrl?: string; coverUrl?: string; previewStart: number; previewEnd: number; position: number; active: number };
type Artist = { id: string; name: string; imageUrl?: string; position: number; active: number };
type Settings = { votingOpen: number; albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };
type Result = { id: string; title?: string; name?: string; albumTitle?: string; votes: number };
type IvrPrompt = { key: string; label: string; audioUrl: string; yemotPath: string; updatedAt: number };
type Readiness = { ready: boolean; warnings: string[]; counts: { albums: number; songs: number; artists: number; missingCovers: number; missingSongs: number } };
type PollArchive = { key: string; name: string; createdAt: number; votes: number; albums: number; songs: number; artists: number };
type Survey = { id: string; name: string; active: number; createdAt: number; votingOpen: number; albums: number; songs: number; artists: number; votes: number };
type SuspiciousVote = { fingerprint: string; count: number; voters: string[] };
type Overview = { albums: Album[]; songs: Song[]; artists: Artist[]; managers: string[]; yemotConnected: boolean; ttsAvailable: boolean; votes: { total?: number; phone?: number; site?: number }; settings: Settings; readiness: Readiness; ivrPrompts: IvrPrompt[]; results: { albums: Result[]; songs: Result[]; artists: Result[] }; surveys: Survey[]; activeSurvey: Survey | null; suspicious: SuspiciousVote[] };
type Tab = "dashboard" | "surveys" | "albums" | "artists" | "ivr" | "settings" | "managers" | "results" | "archives";

const SYSTEM_PROMPTS = [
  ["system:main_menu", "תפריט ראשי — אלבומים 1, שירים 2, זמרים 3"], ["system:albums_intro", "פתיח לבחירת אלבומים"],
  ["system:songs_intro", "פתיח לבחירת שירים"], ["system:artists_intro", "פתיח לבחירת זמרים"],
  ["system:need_albums", "יש לבחור קודם אלבומים"], ["system:section_saved", "הבחירה נשמרה וחוזרים לתפריט"],
  ["system:already_voted", "כבר הצבעתם"], ["system:voting_closed", "ההצבעה עדיין אינה פתוחה"],
  ["system:not_ready", "רשימות המצעד עדיין אינן מוכנות"], ["system:error", "אירעה שגיאה"],
  ["system:success", "ההצבעה נקלטה בהצלחה"],
] as const;

export default function AdminPage() {
  const [user] = useCurrentUser();
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [albumOrderOverride, setAlbumOrder] = useState<Album[] | null>(null);
  const [artistOrderOverride, setArtistOrder] = useState<Artist[] | null>(null);
  const load = useCallback(() => fetch("/api/admin/overview", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); setAlbumOrder(null); setArtistOrder(null); setData(await response.json()); }).catch(() => setMessage("לא הצלחנו לטעון את נתוני הניהול.")), []);
  useEffect(() => { if (user?.isAdmin) load(); }, [user, load]);
  const albumOrder = useMemo(() => albumOrderOverride ?? data?.albums ?? [], [albumOrderOverride, data]);
  const artistOrder = useMemo(() => artistOrderOverride ?? data?.artists ?? [], [artistOrderOverride, data]);

  if (user === undefined) return <main className="login-shell"><div className="loading">בודקים הרשאות…</div></main>;
  if (!user) return <LoginScreen />;
  if (!user.isAdmin) return <main className="login-shell" dir="rtl"><section className="login-card"><h1>אין גישה לעמוד הזה</h1><p>החשבון הזה אינו מוגדר כמנהל.</p><Link className="continue admin-home-link" href="/">חזרה להצבעה</Link></section></main>;

  const api = async (path: string, options: RequestInit) => {
    const response = await fetch(path, options), result = await response.json();
    if (!response.ok) throw new Error(result.error || "הפעולה נכשלה.");
    return result;
  };
  const saveCatalog = async (event: FormEvent<HTMLFormElement>, kind: "album" | "song" | "artist") => {
    event.preventDefault(); setMessage("שומרים…");
    try { await api("/api/admin/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...Object.fromEntries(new FormData(event.currentTarget)), kind }) }); setMessage("נשמר בהצלחה."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "השמירה נכשלה."); }
  };
  const toggle = async (kind: "album" | "song" | "artist", id: string, active: boolean) => { try { await api("/api/admin/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, active }) }); setMessage("המצב עודכן."); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "העדכון נכשל."); } };
  const remove = async (kind: "album" | "song" | "artist", id: string) => {
    const label = kind === "album" ? "האלבום, כל השירים וכל הקבצים שלו" : kind === "song" ? "השיר וקובץ השמע שלו" : "הזמר";
    if (!confirm(`למחוק לצמיתות את ${label}?`)) return;
    setMessage("מוחקים…");
    try { await api("/api/admin/catalog", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id }) }); setMessage("נמחק בהצלחה."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "המחיקה נכשלה."); }
  };
  const uploadMedia = async (albumId: string, file: File, position = 0) => {
    const form = new FormData(); form.set("albumId", albumId); form.set("kind", "audio"); form.set("file", file); form.set("title", file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, "")); form.set("position", String(position));
    await api("/api/admin/media", { method: "POST", body: form });
  };
  const uploadAlbum = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setUploading(true); setMessage("מכינים את האלבום…");
    try {
      const form = event.currentTarget, values = new FormData(form), title = String(values.get("title") || "").trim(), artistName = String(values.get("artistName") || "").trim();
      const folderInput = form.elements.namedItem("folder") as HTMLInputElement, zipInput = form.elements.namedItem("zip") as HTMLInputElement;
      const files: UploadFile[] = folderInput.files?.length ? fromDirectory(folderInput.files) : zipInput.files?.[0] ? await fromZip(zipInput.files[0]) : [];
      const split = splitAlbumFiles(files);
      if (!title || !artistName || !split.audio.length) throw new Error("יש להזין שם, אמן ולבחור תיקייה או ZIP עם קובצי שמע.");
      const { id } = await api("/api/admin/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "album", title, artistName }) });
      for (let index = 0; index < split.audio.length; index++) { setMessage(`מעלים שיר ${index + 1} מתוך ${split.audio.length}…`); await uploadMedia(id, split.audio[index], index); }
      form.reset(); setMessage(`האלבום הועלה בהצלחה עם ${split.audio.length} שירים.`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "העלאת האלבום נכשלה."); } finally { setUploading(false); }
  };
  const addFiles = async (albumId: string, files: FileList | null) => {
    if (!files?.length) return; setUploading(true);
    try { const split = splitAlbumFiles(fromDirectory(files)); for (let i = 0; i < split.audio.length; i++) { setMessage(`מעלים קובץ ${i + 1} מתוך ${split.audio.length}…`); await uploadMedia(albumId, split.audio[i], i); } setMessage("הקבצים נוספו לאלבום."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "ההעלאה נכשלה."); } finally { setUploading(false); }
  };
  const uploadArtistImage = async (artistId: string, file: File) => {
    setMessage("מעלים תמונת זמר…");
    try { const form = new FormData(); form.set("artistId", artistId); form.set("kind", "artist"); form.set("file", file); await api("/api/admin/media", { method: "POST", body: form }); setMessage("תמונת הזמר עודכנה."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "העלאת התמונה נכשלה."); }
  };
  const removeArtistImage = async (artistId: string) => {
    if (!confirm("להסיר את תמונת הזמר?")) return;
    try { await api("/api/admin/media", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ artistId, kind: "artist" }) }); setMessage("תמונת הזמר הוסרה."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "מחיקת התמונה נכשלה."); }
  };
  const addArtist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form), name = String(values.get("name") || "").trim();
    if (!name) return setMessage("יש להזין שם זמר.");
    setMessage("שומרים…");
    try {
      const { id } = await api("/api/admin/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "artist", name, imageUrl: String(values.get("imageUrl") || ""), position: Number(values.get("position") || 0) }) });
      const file = (form.elements.namedItem("image") as HTMLInputElement)?.files?.[0];
      if (file) { const body = new FormData(); body.set("artistId", id); body.set("kind", "artist"); body.set("file", file); setMessage("מעלים תמונת זמר…"); await api("/api/admin/media", { method: "POST", body }); }
      form.reset(); setMessage("הזמר נוסף."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "השמירה נכשלה."); }
  };

  const moveItem = async (kind: "album" | "artist", index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (kind === "album") {
      if (target < 0 || target >= albumOrder.length) return;
      const next = [...albumOrder]; [next[index], next[target]] = [next[target], next[index]]; setAlbumOrder(next);
      await fetch("/api/admin/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "album", ids: next.map((a) => a.id) }) }).catch(() => {});
    } else {
      if (target < 0 || target >= artistOrder.length) return;
      const next = [...artistOrder]; [next[index], next[target]] = [next[target], next[index]]; setArtistOrder(next);
      await fetch("/api/admin/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "artist", ids: next.map((a) => a.id) }) }).catch(() => {});
    }
  };
  const uploadAlbumCover = async (albumId: string, file: File) => {
    setMessage("מעלים תמונת אלבום…");
    try { const form = new FormData(); form.set("albumId", albumId); form.set("kind", "cover"); form.set("file", file); await api("/api/admin/media", { method: "POST", body: form }); setMessage("תמונת האלבום עודכנה."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "העלאת התמונה נכשלה."); }
  };
  const removeAlbumCover = async (albumId: string) => {
    if (!confirm("להסיר את תמונת האלבום?")) return;
    try { await api("/api/admin/media", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ albumId, kind: "cover" }) }); setMessage("תמונת האלבום הוסרה."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "מחיקת התמונה נכשלה."); }
  };

  return <main className="admin-shell" dir="rtl">
    <aside className="admin-side"><div className="vote-header"><img className="logo-mark" src="/favicon.svg" alt="ראש בראש" /><div><strong>ראש בראש</strong><small>מערכת ניהול</small></div></div><nav>
      <Nav active={tab === "dashboard"} onClick={() => setTab("dashboard")}>סקירה כללית</Nav><Nav active={tab === "surveys"} onClick={() => setTab("surveys")}>סקרים</Nav><Nav active={tab === "albums"} onClick={() => setTab("albums")}>אלבומים ושירים</Nav><Nav active={tab === "artists"} onClick={() => setTab("artists")}>זמרים</Nav><Nav active={tab === "ivr"} onClick={() => setTab("ivr")}>קריינות לקו</Nav><Nav active={tab === "settings"} onClick={() => setTab("settings")}>הגדרות הסקר</Nav><Nav active={tab === "archives"} onClick={() => setTab("archives")}>ארכיון וגיבויים</Nav><Nav active={tab === "managers"} onClick={() => setTab("managers")}>מנהלי המערכת</Nav><Nav active={tab === "results"} onClick={() => setTab("results")}>תוצאות</Nav><Link href="/">מעבר לאתר</Link>
    </nav><button className="admin-logout" onClick={logout}>יציאה מהחשבון</button></aside>
    <section className="admin-main"><header><div><p className="kicker">שלום, {user.name}{data?.activeSurvey && <> · עורכים כעת: <b className="active-survey-tag">{data.activeSurvey.name}</b></>}</p><h1>{tab === "dashboard" ? "מרכז הניהול" : ({ surveys: "סקרים", albums: "אלבומים ושירים", artists: "זמרים", ivr: "קריינות לקו", settings: "הגדרות הסקר", archives: "ארכיון וגיבויים", managers: "מנהלי המערכת", results: "תוצאות" } as Record<string, string>)[tab]}</h1></div><span>{user.picture && <img src={user.picture} alt="" />}{user.email}</span></header>
      <div className="stat-grid"><article><small>סה״כ הצבעות</small><b>{data?.votes.total ?? 0}</b></article><article><small>הצבעות באתר</small><b>{data?.votes.site ?? 0}</b></article><article><small>הצבעות בטלפון</small><b>{data?.votes.phone ?? 0}</b></article><article><small>מצב הסקר</small><b className="status-text">{data?.settings.votingOpen ? "פתוח" : "סגור"}</b></article></div>
      {message && <p className="admin-message">{message}</p>}
      {tab === "dashboard" && <Dashboard data={data} onNavigate={setTab} />}
      {tab === "surveys" && data && <SurveysPanel data={data} onChanged={load} onMessage={setMessage} />}
      {tab === "ivr" && data && <IvrPanel data={data} onSaved={load} onMessage={setMessage} />}
      {tab === "settings" && data && <SettingsPanel data={data} onSaved={async () => { await load(); }} />}
      {tab === "archives" && <ArchivesPanel onChanged={load} onMessage={setMessage} />}
      {tab === "albums" && <><AdminSection title="העלאת אלבום שלם"><p className="panel-help">בחרו תיקייה או ZIP עם קובצי שמע. אפשר להעלות תמונת אלבום ידנית או לתת לה להישלף אוטומטית מה־metadata של השירים.</p><form className="upload-form" onSubmit={uploadAlbum}><input name="title" placeholder="שם האלבום" required /><input name="artistName" placeholder="שם האמן" required /><label className="file-field">בחירת תיקייה<input name="folder" type="file" multiple accept="audio/*" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} /></label><label className="file-field">או קובץ ZIP<input name="zip" type="file" accept=".zip,application/zip" /></label><button disabled={uploading}>{uploading ? "מעלה…" : "יצירת האלבום"}</button></form></AdminSection><div className="album-admin-grid">{albumOrder.map((album, index) => <div key={album.id} className="reorder-row"><div className="reorder-arrows"><button type="button" disabled={index === 0} onClick={() => moveItem("album", index, -1)} aria-label="הזז למעלה">▲</button><button type="button" disabled={index === albumOrder.length - 1} onClick={() => moveItem("album", index, 1)} aria-label="הזז למטה">▼</button></div><AlbumEditor album={album} songs={data?.songs.filter((song) => song.albumId === album.id) ?? []} onSave={saveCatalog} onToggle={toggle} onDelete={remove} onFiles={(files) => addFiles(album.id, files)} onUploadCover={uploadAlbumCover} onRemoveCover={removeAlbumCover} /></div>)}</div></>}
      {tab === "artists" && <AdminSection title="ניהול זמרים"><p className="panel-help">אפשר להוסיף תמונת זמר בהעלאת קובץ, או להדביק קישור. לכל זמר קיים אפשר להעלות/להחליף תמונה משורת הזמר.</p><form className="artist-form" onSubmit={addArtist}><input name="name" placeholder="שם הזמר" required /><input name="imageUrl" placeholder="קישור לתמונה (לא חובה)" /><input name="position" type="number" placeholder="סדר" /><label className="file-field">תמונת זמר (קובץ)<input name="image" type="file" accept="image/*" /></label><button>הוסף זמר</button></form><div className="admin-list">{artistOrder.map((item, index) => <div key={item.id} className="reorder-row"><div className="reorder-arrows"><button type="button" disabled={index === 0} onClick={() => moveItem("artist", index, -1)} aria-label="הזז למעלה">▲</button><button type="button" disabled={index === artistOrder.length - 1} onClick={() => moveItem("artist", index, 1)} aria-label="הזז למטה">▼</button></div><ArtistRow item={item} onToggle={toggle} onDelete={remove} onUploadImage={uploadArtistImage} onRemoveImage={removeArtistImage} /></div>)}</div></AdminSection>}
      {tab === "managers" && data && <ManagersPanel managers={data.managers} currentEmail={user.email} onSaved={load} onMessage={setMessage} />}
      {tab === "results" && data && <Results data={data.results} />}
    </section>
  </main>;
}

function Dashboard({ data, onNavigate }: { data: Overview | null; onNavigate(tab: Tab): void }) { return <><div className="dashboard-grid"><button onClick={() => onNavigate("surveys")}><b>{data?.surveys.length ?? 0}</b><span>סקרים</span><small>{data?.activeSurvey ? `פעיל: ${data.activeSurvey.name}` : "בחירה והפעלה"}</small></button><button onClick={() => onNavigate("albums")}><b>{data?.albums.length ?? 0}</b><span>אלבומים</span><small>{data?.songs.length ?? 0} שירים</small></button><button onClick={() => onNavigate("artists")}><b>{data?.artists.length ?? 0}</b><span>זמרים</span><small>לניהול הרשימה</small></button><button onClick={() => onNavigate("settings")}><b>⚙</b><span>הגדרות הסקר</span><small>כמויות, שלבים ופתיחה</small></button><button onClick={() => onNavigate("results")}><b>↗</b><span>תוצאות</span><small>אתר וטלפון יחד</small></button></div>{data?.suspicious && data.suspicious.length > 0 && <AdminSection title="הצבעות חשודות"><p className="panel-help">הצבעות שבוצעו מאותו דפדפן/מחשב עם חשבונות שונים. זה לא בהכרח הונאה — יכול להיות מחשב משותף.</p><div className="suspicious-list">{data.suspicious.map((item) => <div key={item.fingerprint} className="suspicious-row"><span className="suspicious-count">{item.count} הצבעות</span><span className="suspicious-fp">{item.fingerprint.slice(0, 12)}…</span><div className="suspicious-voters">{item.voters.map((v) => <small key={v}>{v}</small>)}</div></div>)}</div></AdminSection>}</>; }

function IvrPanel({ data, onSaved, onMessage }: { data: Overview; onSaved(): Promise<void> | void; onMessage(message: string): void }) {
  const promptFor = (key: string) => data.ivrPrompts?.find((prompt) => prompt.key === key);
  const rows = (items: { key: string; label: string }[]) => <div className="prompt-list">{items.map((item) => <PromptRow key={item.key} item={item} prompt={promptFor(item.key)} ttsAvailable={data.ttsAvailable} onSaved={onSaved} onMessage={onMessage} />)}</div>;
  return <AdminSection title="קריינות הקו הטלפוני">
    <div className={`connection-banner ${data.yemotConnected ? "connected" : "disconnected"}`}><b>{data.yemotConnected ? "החיבור לימות המשיח מוגדר" : "החיבור לימות המשיח עדיין לא מוגדר"}</b><span>{data.yemotConnected ? "קבצים חדשים יישלחו גם לקו." : "הקבצים נשמרים באתר בלבד עד להוספת YEMOT_TOKEN בסביבת Cloudflare."}</span></div>
    <p className="panel-help">בכל שורה אפשר להעלות הקלטה משלכם. אם אין הקלטה פעילה, הקו משתמש בהקראה אוטומטית. התפריט הראשי נשאר קצר: 1 אלבומים, 2 שירים מתוך האלבומים שנבחרו, 3 זמרים.</p>
    <h3 className="prompt-heading">הודעות המערכת</h3>{rows(SYSTEM_PROMPTS.map(([key, label]) => ({ key, label })))}
    <details className="prompt-group"><summary>שמות האלבומים (שלוחת אלבומים)</summary>{rows(data.albums.map((album) => ({ key: `album:${album.id}`, label: `${album.title} — ${album.artistName}` })))}</details>
    <details className="prompt-group"><summary>שמות האלבומים (שלוחת שירים)</summary>{rows(data.albums.map((album) => ({ key: `album-name:${album.id}`, label: `${album.title} — ${album.artistName}` })))}</details>
    <details className="prompt-group"><summary>שמות השירים</summary>{rows(data.songs.map((song) => ({ key: `song:${song.id}`, label: song.title })))}</details>
    <details className="prompt-group"><summary>שמות הזמרים</summary>{rows(data.artists.map((artist) => ({ key: `artist:${artist.id}`, label: artist.name })))}</details>
  </AdminSection>;
}

function PromptRow({ item, prompt, ttsAvailable, onSaved, onMessage }: { item: { key: string; label: string }; prompt?: IvrPrompt; ttsAvailable?: boolean; onSaved(): Promise<void> | void; onMessage(message: string): void }) {
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false), [elapsed, setElapsed] = useState(0), [recorded, setRecorded] = useState<{ file: File; url: string } | null>(null);
  const [ttsPreview, setTtsPreview] = useState<{ file: File; url: string } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null), chunksRef = useRef<Blob[]>([]), timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const submitFile = async (file: File) => {
    setBusy(true); onMessage("מעלים את הקריינות…");
    try {
      const body = new FormData(); body.set("key", item.key); body.set("label", item.label); body.set("file", file);
      const response = await fetch("/api/admin/ivr-prompt", { method: "POST", body }), result = await response.json();
      if (!response.ok) throw new Error(result.error || "העלאת הקריינות נכשלה.");
      onMessage(result.warning || "הקריינות נשמרה והיא פעילה בקו."); await onSaved(); return true;
    } catch (error) { onMessage(error instanceof Error ? error.message : "העלאת הקריינות נכשלה."); return false; }
    finally { setBusy(false); }
  };
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
    if (!file) return onMessage("יש לבחור קובץ שמע.");
    if (await submitFile(file)) form.reset();
  };
  const clearRecording = () => { setRecorded((current) => { if (current) URL.revokeObjectURL(current.url); return null; }); setElapsed(0); };
  const clearTtsPreview = () => { setTtsPreview((current) => { if (current) URL.revokeObjectURL(current.url); return null; }); };
  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return onMessage("הדפדפן אינו תומך בהקלטה. אפשר להעלות קובץ במקום.");
    clearRecording(); clearTtsPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream); recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setRecording(false);
        try {
          const wav = await blobToWav(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
          setRecorded({ file: wav, url: URL.createObjectURL(wav) });
        } catch { onMessage("עיבוד ההקלטה נכשל. נסו שוב או העלו קובץ."); }
      };
      recorder.start(); setRecording(true); setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((value) => value + 1), 1000);
    } catch { onMessage("לא ניתן לגשת למיקרופון. יש לאשר הרשאה בדפדפן."); }
  };
  const stopRecording = () => recorderRef.current?.state === "recording" && recorderRef.current.stop();
  const saveRecording = async () => { if (recorded && await submitFile(recorded.file)) clearRecording(); };
  const saveTtsPreview = async () => { if (ttsPreview && await submitFile(ttsPreview.file)) clearTtsPreview(); };
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const removePrompt = async () => {
    if (!prompt || !confirm("להסיר את הקריינות ולחזור להקראה האוטומטית?")) return;
    const response = await fetch("/api/admin/ivr-prompt", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: item.key }) });
    if (response.ok) { onMessage("הקריינות הוסרה. הקו יחזור להקראה אוטומטית."); await onSaved(); }
  };
  const previewTts = async () => {
    setBusy(true); clearTtsPreview(); onMessage("יוצרים תצוגה מקדימה…");
    try {
      const response = await fetch("/api/admin/ivr-tts-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: item.label }) });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error((result as { error?: string }).error || "יצירת הקריינות נכשלה."); }
      const blob = await response.blob();
      const file = new File([blob], "tts-preview.mp3", { type: "audio/mpeg" });
      setTtsPreview({ file, url: URL.createObjectURL(blob) });
      onMessage("האזינו לתצוגה המקדימה ולחצו ״שמירה לקו״ לאישור.");
    } catch (error) { onMessage(error instanceof Error ? error.message : "יצירת הקריינות נכשלה."); }
    finally { setBusy(false); }
  };
  return <article className="prompt-row">
    <div className="prompt-copy"><b>{item.label}</b><small className={prompt?.yemotPath ? "prompt-live" : ""}>{prompt ? prompt.yemotPath ? "פעיל בקו" : "נשמר באתר — נדרש חיבור לימות המשיח" : "הקראה אוטומטית"}</small>{prompt?.audioUrl && <audio controls preload="metadata" src={prompt.audioUrl} />}</div>
    <div className="prompt-actions">
      <div className="prompt-recorder">
        {recording ? <button type="button" className="rec-stop" onClick={stopRecording}>■ עצור ({formatTime(elapsed)})</button>
          : <button type="button" className="rec-start" onClick={startRecording} disabled={busy}>🎙 הקלטה ישירה</button>}
        {recorded && !recording && <><audio controls preload="metadata" src={recorded.url} /><button type="button" onClick={saveRecording} disabled={busy}>{busy ? "שומר…" : "שמירת ההקלטה לקו"}</button><button type="button" className="danger" onClick={clearRecording}>ביטול</button></>}
      </div>
      {ttsAvailable && !recording && !recorded && !ttsPreview && <button type="button" className="tts-btn" onClick={previewTts} disabled={busy}>{busy ? "יוצר..." : "🔊 קריינות AI"}</button>}
      {ttsPreview && <div className="tts-preview"><audio controls autoPlay preload="metadata" src={ttsPreview.url} /><button type="button" onClick={saveTtsPreview} disabled={busy}>{busy ? "שומר…" : "שמירה לקו"}</button><button type="button" className="danger" onClick={clearTtsPreview}>ביטול</button></div>}
      <form onSubmit={upload}><input name="file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg" /><button disabled={busy}>{busy ? "מעלה…" : prompt ? "החלפה" : "העלאה"}</button>{prompt && <button type="button" className="danger" onClick={removePrompt}>הסרה</button>}</form>
    </div>
  </article>;
}

function SettingsPanel({ data, onSaved }: { data: Overview; onSaved(): void }) {
  const { settings, readiness } = data;
  const [message, setMessage] = useState("");
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); const response = await fetch("/api/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (response.ok) { setMessage(body.votingOpen ? "הסקר פורסם ופתוח להצבעה באתר ובקו." : "הסקר נשמר כטיוטה וסגור למאזינים."); onSaved(); } else setMessage(result.error || "לא הצלחנו לשמור את ההגדרות."); };
  const clearPoll = async () => { if (!confirm("למחוק את כל הסקר הפעיל? לפני המחיקה יישמר ארכיון מלא ויירד גיבוי למחשב.")) return; const backup = await fetch("/api/admin/backup"); if (!backup.ok) return setMessage("לא הצלחנו ליצור גיבוי ולכן הסקר לא נמחק."); const blob = await backup.blob(), link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `rosh-berosh-backup-${Date.now()}.json`; link.click(); URL.revokeObjectURL(link.href); const response = await fetch("/api/admin/poll?skipArchive=1", { method: "DELETE" }); if (response.ok) { setMessage("הסקר הועבר לארכיון, הגיבוי ירד למחשב ונפתחה טיוטה חדשה."); onSaved(); } else setMessage("מחיקת הסקר נכשלה."); };
  const resetVotes = async () => { if (!confirm("לאפס את כל ההצבעות בסקר הפעיל? הפעולה בלתי הפיכה. האלבומים, השירים והזמרים יישארו.")) return; setMessage("מאפסים הצבעות..."); try { const response = await fetch("/api/admin/reset-votes", { method: "POST" }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "איפוס ההצבעות נכשל."); setMessage(`${result.deleted} הצבעות נמחקו. האלבומים, השירים והזמרים נשמרו.`); onSaved(); } catch (error) { setMessage(error instanceof Error ? error.message : "איפוס ההצבעות נכשל."); } };
  return <AdminSection title="הכנת סקר ופרסום"><div className={`poll-state ${settings.votingOpen ? "published" : "draft"}`}><b>{settings.votingOpen ? "הסקר פעיל" : "טיוטה — הסקר עדיין לא מוצג למאזינים"}</b><span>{settings.votingOpen ? "האתר והקו הטלפוני מקבלים הצבעות." : "אפשר להעלות תוכן ולשנות הכל בלי שאיש יוכל להצביע."}</span></div><div className={`readiness-card ${readiness.ready ? "ready" : "not-ready"}`}><h3>{readiness.ready ? "הסקר מוכן לפרסום" : "בדיקת מוכנות לפרסום"}</h3><div className="readiness-counts"><span>✓ {readiness.counts.albums} אלבומים</span><span>✓ {readiness.counts.songs} שירים</span><span>✓ {readiness.counts.artists} זמרים</span></div>{readiness.warnings.length ? <ul>{readiness.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>כל הרשימות מוכנות. אפשר לפרסם.</p>}{readiness.counts.missingCovers > 0 && <small>המלצה: חסרות עטיפות ל־{readiness.counts.missingCovers} אלבומים, אבל אפשר לפרסם גם כך.</small>}</div><form className="settings-form" onSubmit={save}><label className="master-switch"><input type="checkbox" name="votingOpen" defaultChecked={!!settings.votingOpen} /> פרסם ופתח את הסקר להצבעה</label><RuleRow title="אלבומים" prefix="albums" enabled={settings.albumsEnabled} min={settings.albumsMin} max={settings.albumsMax} /><RuleRow title="שירים מכל אלבום" prefix="songs" enabled={settings.songsEnabled} min={settings.songsMin} max={settings.songsMax} /><RuleRow title="זמרים" prefix="artists" enabled={settings.artistsEnabled} min={settings.artistsMin} max={settings.artistsMax} /><button>{settings.votingOpen ? "שמירת הגדרות הסקר" : "שמירה כטיוטה / פרסום"}</button><small>הסקר נשאר טיוטה עד לסימון „פרסם”. כל שינוי חל גם באתר וגם בקו הטלפוני.</small></form>{message && <p className="poll-feedback">{message}</p>}<button className="danger clear-poll" onClick={resetVotes}>איפוס כל ההצבעות</button><button className="danger clear-poll" onClick={clearPoll}>העברה לארכיון והתחלת סקר חדש</button></AdminSection>;
}
function RuleRow({ title, prefix, enabled, min, max }: { title: string; prefix: string; enabled: number; min: number; max: number }) { return <div className="rule-row"><label><input type="checkbox" name={`${prefix}Enabled`} defaultChecked={!!enabled} /> {title}</label><label>מינימום<input type="number" name={`${prefix}Min`} min="0" max="50" defaultValue={min} /></label><label>מקסימום<input type="number" name={`${prefix}Max`} min="0" max="50" defaultValue={max} /></label></div>; }

function AlbumEditor({ album, songs, onSave, onToggle, onDelete, onFiles, onUploadCover, onRemoveCover }: { album: Album; songs: Song[]; onSave(event: FormEvent<HTMLFormElement>, kind: "album" | "song" | "artist"): void; onToggle(kind: "album" | "song" | "artist", id: string, active: boolean): void; onDelete(kind: "album" | "song" | "artist", id: string): void; onFiles(files: FileList | null): void; onUploadCover(albumId: string, file: File): Promise<void> | void; onRemoveCover(albumId: string): Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const uniqueCovers = [...new Set(songs.map((s) => s.coverUrl).filter(Boolean))];
  const derivedCover = album.coverUrl || (uniqueCovers.length >= 1 ? uniqueCovers[0] : null);
  const pickCover = async (files: FileList | null) => { const file = files?.[0]; if (!file) return; setBusy(true); try { await onUploadCover(album.id, file); } finally { setBusy(false); } };
  return <article className="album-editor"><header onClick={() => setOpen(!open)}>{derivedCover ? <img src={derivedCover} alt="" /> : <i>♫</i>}<div><b>{album.title}</b><small>{album.artistName} · {songs.length} שירים{uniqueCovers.length > 1 ? ` · ${uniqueCovers.length} תמונות שונות` : ""}</small></div><span>{open ? "⌃" : "⌄"}</span></header>{open && <div className="album-editor-body"><form onSubmit={(event) => onSave(event, "album")}><input type="hidden" name="id" value={album.id} /><input name="title" defaultValue={album.title} /><input name="artistName" defaultValue={album.artistName} /><input name="position" type="number" defaultValue={album.position} /><button>שמירת אלבום</button></form><div className="album-tools"><label className="file-field">הוספת שירים<input type="file" multiple accept="audio/*" onChange={(event) => onFiles(event.target.files)} /></label><label className="file-field">{busy ? "מעלה…" : album.coverUrl ? "החלפת עטיפה" : "העלאת עטיפה"}<input type="file" accept="image/*" disabled={busy} onChange={(event) => pickCover(event.target.files)} /></label>{album.coverUrl && <button type="button" onClick={() => onRemoveCover(album.id)}>הסרת עטיפה</button>}<Toggle active={!!album.active} onClick={() => onToggle("album", album.id, !album.active)} /><button type="button" className="danger" onClick={() => onDelete("album", album.id)}>מחיקת אלבום מלא</button></div><div className="song-admin-list">{songs.map((song) => <SongEditor key={song.id} song={song} onSave={onSave} onToggle={onToggle} onDelete={onDelete} />)}</div></div>}</article>;
}

function SongEditor({ song, onSave, onToggle, onDelete }: { song: Song; onSave(event: FormEvent<HTMLFormElement>, kind: "album" | "song" | "artist"): void; onToggle(kind: "album" | "song" | "artist", id: string, active: boolean): void; onDelete(kind: "album" | "song" | "artist", id: string): void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [start, setStart] = useState(song.previewStart || 0), [end, setEnd] = useState(song.previewEnd || 0), [duration, setDuration] = useState(0), [position, setPosition] = useState(0), [playing, setPlaying] = useState(false), [analyzing, setAnalyzing] = useState(false);
  const clamp = (value: number) => Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Math.round(value * 10) / 10));
  const seek = (value: number) => { const next = clamp(value); setPosition(next); if (audio.current) audio.current.currentTime = next; };
  const setStartHere = () => { const next = clamp(audio.current?.currentTime ?? position); setStart(next); if (end && end <= next) setEnd(clamp(next + 25)); };
  const setEndHere = () => { const next = clamp(audio.current?.currentTime ?? position); setEnd(Math.max(start + 1, next)); };
  const preview = async () => { const element = audio.current; if (!element) return; element.currentTime = start; await element.play(); setPlaying(true); };
  const applySuggestion = (suggestion: { start: number; end: number }) => { setStart(clamp(suggestion.start)); setEnd(clamp(suggestion.end)); };
  const analyze = async () => {
    if (!song.audioUrl) return;
    setAnalyzing(true);
    try {
      const response = await fetch("/api/admin/suggest-chorus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ songId: song.id }) });
      if (response.ok) { const result = await response.json(); return applySuggestion(result); }
      // AI unavailable or failed — fall back to the local audio heuristic.
      applySuggestion(await suggestChorus(song.audioUrl));
    } catch {
      try { applySuggestion(await suggestChorus(song.audioUrl)); } catch { /* leave current values */ }
    } finally { setAnalyzing(false); }
  };
  return <form className="song-editor" onSubmit={(event) => { if (end && end <= start) { event.preventDefault(); return; } onSave(event, "song"); }}><input type="hidden" name="id" value={song.id} /><input type="hidden" name="albumId" value={song.albumId} />{song.coverUrl && <img className="song-cover-thumb" src={song.coverUrl} alt="" />}<input className="song-title-input" name="title" defaultValue={song.title} />{song.audioUrl && <div className="chorus-picker"><audio ref={audio} preload="metadata" src={song.audioUrl} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => { const current = event.currentTarget.currentTime; setPosition(current); if (playing && end > start && current >= end) { event.currentTarget.pause(); setPlaying(false); event.currentTarget.currentTime = start; } }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} /><div className="chorus-player"><button type="button" className="round-play" onClick={() => playing ? audio.current?.pause() : preview()}>{playing ? "❚❚" : "▶"}</button><input aria-label="מיקום בשיר" type="range" min="0" max={Math.max(1, duration)} step="0.1" value={position} onChange={(event) => seek(Number(event.target.value))} /><span>{formatTime(position)} / {formatTime(duration)}</span></div><div className="chorus-actions"><button type="button" onClick={setStartHere}>קבע התחלה כאן</button><button type="button" onClick={setEndHere}>קבע סיום כאן</button><button type="button" onClick={preview}>השמע את הקטע</button><button type="button" onClick={analyze} disabled={analyzing}>{analyzing ? "מנתח…" : "פזמון AI"}</button></div></div>}<label>תחילת הקטע<input name="previewStart" type="number" min="0" max={duration || undefined} step="0.1" value={start} onChange={(e) => setStart(clamp(Number(e.target.value)))} /></label><label>סיום הקטע<input name="previewEnd" type="number" min="0" max={duration || undefined} step="0.1" value={end} onChange={(e) => setEnd(clamp(Number(e.target.value)))} /></label><div className="song-editor-actions"><button>שמירת השיר</button><Toggle active={!!song.active} onClick={() => onToggle("song", song.id, !song.active)} /><button type="button" className="danger" onClick={() => onDelete("song", song.id)}>מחיקת השיר והקובץ</button></div>{end > 0 && end <= start && <small className="field-error">זמן הסיום חייב להיות אחרי זמן ההתחלה.</small>}</form>;
}

function ArtistRow({ item, onToggle, onDelete, onUploadImage, onRemoveImage }: { item: Artist; onToggle(kind: "album" | "song" | "artist", id: string, active: boolean): void; onDelete(kind: "album" | "song" | "artist", id: string): void; onUploadImage(artistId: string, file: File): Promise<void> | void; onRemoveImage(artistId: string): Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (files: FileList | null) => { const file = files?.[0]; if (!file) return; setBusy(true); try { await onUploadImage(item.id, file); } finally { setBusy(false); } };
  return <article><div>{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <i>{item.name[0]}</i>}<span><b>{item.name}</b><small>זמר</small></span></div><div className="row-actions"><label className="mini-upload">{busy ? "מעלה…" : item.imageUrl ? "החלפת תמונה" : "העלאת תמונה"}<input type="file" accept="image/*" disabled={busy} onChange={(event) => pick(event.target.files)} /></label>{item.imageUrl && <button type="button" onClick={() => onRemoveImage(item.id)}>הסרת תמונה</button>}<Toggle active={!!item.active} onClick={() => onToggle("artist", item.id, !item.active)} /><button className="danger" onClick={() => onDelete("artist", item.id)}>מחיקה</button></div></article>;
}

function ManagersPanel({ managers, currentEmail, onSaved, onMessage }: { managers: string[]; currentEmail: string; onSaved(): Promise<void> | void; onMessage(message: string): void }) {
  const add = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget, email = String(new FormData(form).get("email") || "").trim(); const response = await fetch("/api/admin/managers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }), result = await response.json(); if (!response.ok) return onMessage(result.error || "הוספת המנהל נכשלה."); form.reset(); onMessage("המנהל נוסף. הכפתור לניהול יופיע לו בכניסה הבאה."); await onSaved(); };
  const remove = async (email: string) => { if (!confirm(`להסיר הרשאת ניהול מ־${email}?`)) return; const response = await fetch("/api/admin/managers", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }), result = await response.json(); if (!response.ok) return onMessage(result.error || "הסרת המנהל נכשלה."); onMessage("הרשאת הניהול הוסרה."); await onSaved(); };
  return <AdminSection title="הרשאות מנהלים"><p className="panel-help">הוסיפו כתובת Google. משתמש רגיל לא יראה את מערכת הניהול; לחשבון שמופיע כאן יופיע כפתור ניהול לאחר הכניסה.</p><form onSubmit={add}><input name="email" type="email" placeholder="כתובת Gmail או Google Workspace" required /><button>הוספת מנהל</button></form><div className="admin-list manager-list">{managers.map((email) => <article key={email}><div><i>מ</i><span><b>{email}</b><small>{email === currentEmail ? "החשבון הנוכחי" : "מנהל מערכת"}</small></span></div><button type="button" className="danger" disabled={email === currentEmail} onClick={() => remove(email)}>הסרת הרשאה</button></article>)}</div></AdminSection>;
}

function formatTime(value: number) { if (!Number.isFinite(value) || value < 0) return "0:00"; const minutes = Math.floor(value / 60), seconds = Math.floor(value % 60); return `${minutes}:${String(seconds).padStart(2, "0")}`; }

function Results({ data }: { data: Overview["results"] }) {
  const [kind, setKind] = useState<keyof Overview["results"]>("albums");
  const [exporting, setExporting] = useState(false);
  const list = data[kind];
  const download = async () => {
    setExporting(true);
    try {
      const allRows: { title: string; albumTitle: string; votes: number }[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const response = await fetch(`/api/admin/export?kind=${kind}&page=${page}`, { cache: "no-store" });
        const result = await response.json() as { rows: { title: string; albumTitle: string; votes: number }[]; hasMore: boolean };
        allRows.push(...result.rows);
        hasMore = result.hasMore;
        page++;
      }
      const heading = kind === "albums" ? "אלבומים" : kind === "songs" ? "שירים" : "זמרים";
      downloadResultsXlsx(allRows.map((item, index) => ({ place: index + 1, title: item.title || "", album: item.albumTitle || "", votes: Number(item.votes) })), heading, `rosh-berosh-${kind}.xlsx`);
    } finally { setExporting(false); }
  };
  return <AdminSection title="תוצאות בזמן אמת"><div className="result-tabs"><button onClick={() => setKind("albums")}>אלבומים</button><button onClick={() => setKind("songs")}>שירים</button><button onClick={() => setKind("artists")}>זמרים</button><button className="export-results" onClick={download} disabled={exporting}>{exporting ? "מייצא…" : "הורדת Excel אמיתי"}</button></div><p className="panel-help">קובץ ‎.xlsx מסודר עם הדירוג והקולות.</p><div className="results-table">{list.map((item, index) => <div key={item.id}><b>{index + 1}</b><span>{item.title || item.name}<small>{item.albumTitle}</small></span><strong>{item.votes} קולות</strong></div>)}</div></AdminSection>;
}

function ArchivesPanel({ onChanged, onMessage }: { onChanged(): Promise<void> | void; onMessage(message: string): void }) {
  const [archives, setArchives] = useState<PollArchive[]>([]), [loading, setLoading] = useState(true);
  const loadArchives = useCallback(() => { setLoading(true); return fetch("/api/admin/archives", { cache: "no-store" }).then((response) => response.json()).then((result) => setArchives(result.archives || [])).finally(() => setLoading(false)); }, []);
  useEffect(() => { let active = true; fetch("/api/admin/archives", { cache: "no-store" }).then((response) => response.json()).then((result) => { if (active) setArchives(result.archives || []); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const archive = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget, name = String(new FormData(form).get("name") || "").trim(); const response = await fetch("/api/admin/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); if (response.ok) { form.reset(); onMessage("הסקר נשמר בארכיון."); await loadArchives(); } else onMessage("שמירת הארכיון נכשלה."); };
  const restore = async (item: PollArchive) => { if (!confirm(`לשחזר את „${item.name}”? הסקר הנוכחי יגובה אוטומטית והשחזור ייפתח כטיוטה.`)) return; const response = await fetch("/api/admin/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ restoreKey: item.key }) }); if (response.ok) { onMessage("הסקר שוחזר כטיוטה. בדקו אותו לפני הפרסום."); await onChanged(); } else onMessage("השחזור נכשל."); };
  const remove = async (item: PollArchive) => { if (!confirm(`למחוק את „${item.name}” מהארכיון?`)) return; const response = await fetch("/api/admin/archive", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: item.key }) }); if (response.ok) { onMessage("העותק נמחק מהארכיון."); await loadArchives(); } };
  return <AdminSection title="ארכיון סקרים וגיבויים"><p className="panel-help">שמרו גרסה מלאה של הסקר הנוכחי. אפשר לשחזר כל סקר כטיוטה, בלי לפרסם אותו מיד.</p><form className="archive-form" onSubmit={archive}><input name="name" placeholder="שם הסקר בארכיון" /><button>שמירת הסקר הנוכחי בארכיון</button></form>{loading ? <p>טוען ארכיון…</p> : <div className="archive-list">{archives.length ? archives.map((item) => <article key={item.key}><div><b>{item.name}</b><small>{new Date(item.createdAt).toLocaleString("he-IL")} · {item.votes} הצבעות</small><span>{item.albums} אלבומים · {item.songs} שירים · {item.artists} זמרים</span></div><div><button onClick={() => restore(item)}>שחזור כטיוטה</button><button className="danger" onClick={() => remove(item)}>מחיקה מהארכיון</button></div></article>) : <p>עדיין אין סקרים בארכיון.</p>}</div>}</AdminSection>;
}
function SurveysPanel({ data, onChanged, onMessage }: { data: Overview; onChanged(): Promise<void> | void; onMessage(message: string): void }) {
  const surveys = data.surveys ?? [];
  const send = async (method: string, body: Record<string, unknown>, ok: string) => {
    onMessage("שומרים…");
    try {
      const response = await fetch("/api/admin/surveys", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "הפעולה נכשלה.");
      onMessage(ok); await onChanged();
    } catch (error) { onMessage(error instanceof Error ? error.message : "הפעולה נכשלה."); }
  };
  const create = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget, name = String(new FormData(form).get("name") || "").trim(); if (!name) return onMessage("יש להזין שם לסקר."); await send("POST", { name }, "הסקר נוצר. אפשר להפעיל אותו וליצור לו תוכן."); form.reset(); };
  const activate = async (survey: Survey) => {
    if (survey.active) return;
    if (!confirm(`להפעיל את „${survey.name}”? הסקר הפעיל הנוכחי יוסתר מהאתר ומהקו הטלפוני, וכל הניהול יעבור לסקר הזה.`)) return;
    onMessage("מפעילים את הסקר…");
    try {
      const response = await fetch("/api/admin/surveys/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: survey.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "ההפעלה נכשלה.");
      onMessage(`„${survey.name}” הוא כעת הסקר הפעיל.`); await onChanged();
    } catch (error) { onMessage(error instanceof Error ? error.message : "ההפעלה נכשלה."); }
  };
  const rename = async (survey: Survey) => { const name = prompt("שם חדש לסקר:", survey.name)?.trim(); if (!name || name === survey.name) return; await send("POST", { id: survey.id, name }, "שם הסקר עודכן."); };
  const remove = async (survey: Survey) => { if (!confirm(`למחוק את „${survey.name}” לצמיתות? כל האלבומים, השירים, הזמרים וההצבעות של הסקר יימחקו.`)) return; await send("DELETE", { id: survey.id }, "הסקר נמחק."); };
  return <AdminSection title="ניהול סקרים">
    <p className="panel-help">כל סקר שומר את האלבומים, השירים, הזמרים וההצבעות שלו בנפרד. רק סקר אחד יכול להיות פעיל בכל רגע — הפעלת סקר מסתירה אוטומטית את הסקר שהיה פעיל קודם. הניהול (אלבומים, זמרים, הגדרות, תוצאות) מתייחס תמיד לסקר הפעיל.</p>
    <form className="archive-form" onSubmit={create}><input name="name" placeholder="שם הסקר החדש" required /><button>יצירת סקר חדש</button></form>
    <div className="archive-list survey-list">{surveys.map((survey) => <article key={survey.id} className={survey.active ? "survey-active" : ""}>
      <div><b>{survey.name} {survey.active ? <span className="survey-badge">פעיל</span> : survey.votingOpen ? <span className="survey-badge draft">פורסם</span> : <span className="survey-badge draft">טיוטה</span>}</b><small>{new Date(survey.createdAt * 1000).toLocaleDateString("he-IL")} · {survey.votes} הצבעות</small><span>{survey.albums} אלבומים · {survey.songs} שירים · {survey.artists} זמרים</span></div>
      <div>{survey.active ? <button className="toggle on" disabled>הסקר הפעיל</button> : <button onClick={() => activate(survey)}>הפעלה</button>}<button onClick={() => rename(survey)}>שינוי שם</button><button className="danger" disabled={!!survey.active} onClick={() => remove(survey)}>מחיקה</button></div>
    </article>)}</div>
  </AdminSection>;
}
function AdminSection({ title, children }: { title: string; children: ReactNode }) { return <section className="admin-panel"><h2>{title}</h2>{children}</section>; }
function Nav({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) { return <button className={active ? "active" : ""} onClick={onClick}>{children}</button>; }
function Toggle({ active, onClick }: { active: boolean; onClick(): void }) { return <button type="button" className={`toggle ${active ? "on" : ""}`} onClick={onClick}>{active ? "פעיל" : "מוסתר"}</button>; }
