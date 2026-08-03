"use client";

import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LoginScreen, logout, useCurrentUser } from "../auth-ui";
import { fromDirectory, fromZip, splitAlbumFiles, suggestChorus, type UploadFile } from "./upload-utils";

type Album = { id: string; title: string; artistName: string; coverUrl?: string; position: number; active: number };
type Song = { id: string; albumId: string; title: string; audioUrl?: string; previewStart: number; previewEnd: number; position: number; active: number };
type Artist = { id: string; name: string; imageUrl?: string; position: number; active: number };
type Settings = { votingOpen: number; albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };
type Result = { id: string; title?: string; name?: string; albumTitle?: string; votes: number };
type Overview = { albums: Album[]; songs: Song[]; artists: Artist[]; votes: { total?: number; phone?: number; site?: number }; settings: Settings; results: { albums: Result[]; songs: Result[]; artists: Result[] } };
type Tab = "dashboard" | "albums" | "artists" | "settings" | "results";

export default function AdminPage() {
  const [user] = useCurrentUser();
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const load = useCallback(() => fetch("/api/admin/overview", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); setData(await response.json()); }).catch(() => setMessage("לא הצלחנו לטעון את נתוני הניהול.")), []);
  useEffect(() => { if (user?.isAdmin) load(); }, [user, load]);

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
  const toggle = async (kind: "album" | "song" | "artist", id: string, active: boolean) => { await api("/api/admin/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, active }) }); await load(); };
  const remove = async (kind: "album" | "song" | "artist", id: string) => { if (!confirm("למחוק את הפריט לצמיתות?")) return; await api("/api/admin/catalog", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id }) }); await load(); };

  const uploadMedia = async (albumId: string, file: File, kind: "cover" | "audio", position = 0) => {
    const form = new FormData(); form.set("albumId", albumId); form.set("kind", kind); form.set("file", file); form.set("title", file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, "")); form.set("position", String(position));
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
      if (split.cover) { setMessage("מעלים את עטיפת האלבום…"); await uploadMedia(id, split.cover, "cover"); }
      for (let index = 0; index < split.audio.length; index++) { setMessage(`מעלים שיר ${index + 1} מתוך ${split.audio.length}…`); await uploadMedia(id, split.audio[index], "audio", index); }
      form.reset(); setMessage(`האלבום הועלה בהצלחה עם ${split.audio.length} שירים.`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "העלאת האלבום נכשלה."); } finally { setUploading(false); }
  };
  const addFiles = async (albumId: string, files: FileList | null) => {
    if (!files?.length) return; setUploading(true);
    try { const split = splitAlbumFiles(fromDirectory(files)); if (split.cover) await uploadMedia(albumId, split.cover, "cover"); for (let i = 0; i < split.audio.length; i++) { setMessage(`מעלים קובץ ${i + 1} מתוך ${split.audio.length}…`); await uploadMedia(albumId, split.audio[i], "audio", i); } setMessage("הקבצים נוספו לאלבום."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "ההעלאה נכשלה."); } finally { setUploading(false); }
  };

  return <main className="admin-shell" dir="rtl">
    <aside className="admin-side"><div className="vote-header"><div className="logo-mark">ר</div><div><strong>ראש בראש</strong><small>מערכת ניהול</small></div></div><nav>
      <Nav active={tab === "dashboard"} onClick={() => setTab("dashboard")}>סקירה כללית</Nav><Nav active={tab === "albums"} onClick={() => setTab("albums")}>אלבומים ושירים</Nav><Nav active={tab === "artists"} onClick={() => setTab("artists")}>זמרים</Nav><Nav active={tab === "settings"} onClick={() => setTab("settings")}>הגדרות הסקר</Nav><Nav active={tab === "results"} onClick={() => setTab("results")}>תוצאות</Nav><Link href="/">מעבר לאתר</Link>
    </nav><button className="admin-logout" onClick={logout}>יציאה מהחשבון</button></aside>
    <section className="admin-main"><header><div><p className="kicker">שלום, {user.name}</p><h1>{tab === "dashboard" ? "מרכז הניהול" : ({ albums: "אלבומים ושירים", artists: "זמרים", settings: "הגדרות הסקר", results: "תוצאות" } as Record<string, string>)[tab]}</h1></div><span>{user.picture && <img src={user.picture} alt="" />}{user.email}</span></header>
      <div className="stat-grid"><article><small>סה״כ הצבעות</small><b>{data?.votes.total ?? 0}</b></article><article><small>הצבעות באתר</small><b>{data?.votes.site ?? 0}</b></article><article><small>הצבעות בטלפון</small><b>{data?.votes.phone ?? 0}</b></article><article><small>מצב הסקר</small><b className="status-text">{data?.settings.votingOpen ? "פתוח" : "סגור"}</b></article></div>
      {message && <p className="admin-message">{message}</p>}
      {tab === "dashboard" && <Dashboard data={data} onNavigate={setTab} />}
      {tab === "settings" && data && <SettingsPanel settings={data.settings} onSaved={async () => { setMessage("ההגדרות נשמרו גם לאתר וגם לקו."); await load(); }} />}
      {tab === "albums" && <><AdminSection title="העלאת אלבום שלם"><p className="panel-help">בחרו תיקייה או ZIP. התמונה הראשונה תהפוך לעטיפה וכל קובצי השמע יהפכו לשירים.</p><form className="upload-form" onSubmit={uploadAlbum}><input name="title" placeholder="שם האלבום" required /><input name="artistName" placeholder="שם האמן" required /><label className="file-field">בחירת תיקייה<input name="folder" type="file" multiple accept="audio/*,image/*" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} /></label><label className="file-field">או קובץ ZIP<input name="zip" type="file" accept=".zip,application/zip" /></label><button disabled={uploading}>{uploading ? "מעלה…" : "יצירת האלבום"}</button></form></AdminSection><div className="album-admin-grid">{data?.albums.map((album) => <AlbumEditor key={album.id} album={album} songs={data.songs.filter((song) => song.albumId === album.id)} onSave={saveCatalog} onToggle={toggle} onDelete={remove} onFiles={(files) => addFiles(album.id, files)} />)}</div></>}
      {tab === "artists" && <AdminSection title="ניהול זמרים"><form onSubmit={(event) => saveCatalog(event, "artist")}><input name="name" placeholder="שם הזמר" required /><input name="imageUrl" placeholder="קישור לתמונה (לא חובה)" /><input name="position" type="number" placeholder="סדר" /><button>הוסף זמר</button></form><div className="admin-list">{data?.artists.map((item) => <article key={item.id}><div>{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <i>{item.name[0]}</i>}<span><b>{item.name}</b><small>זמר</small></span></div><div className="row-actions"><Toggle active={!!item.active} onClick={() => toggle("artist", item.id, !item.active)} /><button className="danger" onClick={() => remove("artist", item.id)}>מחיקה</button></div></article>)}</div></AdminSection>}
      {tab === "results" && data && <Results data={data.results} />}
    </section>
  </main>;
}

function Dashboard({ data, onNavigate }: { data: Overview | null; onNavigate(tab: Tab): void }) { return <div className="dashboard-grid"><button onClick={() => onNavigate("albums")}><b>{data?.albums.length ?? 0}</b><span>אלבומים</span><small>{data?.songs.length ?? 0} שירים</small></button><button onClick={() => onNavigate("artists")}><b>{data?.artists.length ?? 0}</b><span>זמרים</span><small>לניהול הרשימה</small></button><button onClick={() => onNavigate("settings")}><b>⚙</b><span>הגדרות הסקר</span><small>כמויות, שלבים ופתיחה</small></button><button onClick={() => onNavigate("results")}><b>↗</b><span>תוצאות</span><small>אתר וטלפון יחד</small></button></div>; }

function SettingsPanel({ settings, onSaved }: { settings: Settings; onSaved(): void }) {
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); const response = await fetch("/api/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (response.ok) onSaved(); };
  return <AdminSection title="מבנה הסקר"><form className="settings-form" onSubmit={save}><label className="master-switch"><input type="checkbox" name="votingOpen" defaultChecked={!!settings.votingOpen} /> ההצבעה פתוחה</label><RuleRow title="אלבומים" prefix="albums" enabled={settings.albumsEnabled} min={settings.albumsMin} max={settings.albumsMax} /><RuleRow title="שירים מכל אלבום" prefix="songs" enabled={settings.songsEnabled} min={settings.songsMin} max={settings.songsMax} /><RuleRow title="זמרים" prefix="artists" enabled={settings.artistsEnabled} min={settings.artistsMin} max={settings.artistsMax} /><button>שמירת ההגדרות</button><small>כל שינוי חל אוטומטית גם באתר וגם בקו הטלפוני.</small></form></AdminSection>;
}
function RuleRow({ title, prefix, enabled, min, max }: { title: string; prefix: string; enabled: number; min: number; max: number }) { return <div className="rule-row"><label><input type="checkbox" name={`${prefix}Enabled`} defaultChecked={!!enabled} /> {title}</label><label>מינימום<input type="number" name={`${prefix}Min`} min="0" max="50" defaultValue={min} /></label><label>מקסימום<input type="number" name={`${prefix}Max`} min="0" max="50" defaultValue={max} /></label></div>; }

function AlbumEditor({ album, songs, onSave, onToggle, onDelete, onFiles }: { album: Album; songs: Song[]; onSave(event: FormEvent<HTMLFormElement>, kind: "album" | "song" | "artist"): void; onToggle(kind: "album" | "song" | "artist", id: string, active: boolean): void; onDelete(kind: "album" | "song" | "artist", id: string): void; onFiles(files: FileList | null): void }) {
  const [open, setOpen] = useState(false);
  return <article className="album-editor"><header onClick={() => setOpen(!open)}>{album.coverUrl ? <img src={album.coverUrl} alt="" /> : <i>♫</i>}<div><b>{album.title}</b><small>{album.artistName} · {songs.length} שירים</small></div><span>{open ? "⌃" : "⌄"}</span></header>{open && <div className="album-editor-body"><form onSubmit={(event) => onSave(event, "album")}><input type="hidden" name="id" value={album.id} /><input name="title" defaultValue={album.title} /><input name="artistName" defaultValue={album.artistName} /><input name="position" type="number" defaultValue={album.position} /><button>שמירת אלבום</button></form><div className="album-tools"><label className="file-field">החלפת עטיפה / הוספת שירים<input type="file" multiple accept="audio/*,image/*" onChange={(event) => onFiles(event.target.files)} /></label><Toggle active={!!album.active} onClick={() => onToggle("album", album.id, !album.active)} /><button className="danger" onClick={() => onDelete("album", album.id)}>מחיקת אלבום</button></div><div className="song-admin-list">{songs.map((song) => <SongEditor key={song.id} song={song} onSave={onSave} onToggle={onToggle} onDelete={onDelete} />)}</div></div>}</article>;
}

function SongEditor({ song, onSave, onToggle, onDelete }: { song: Song; onSave(event: FormEvent<HTMLFormElement>, kind: "album" | "song" | "artist"): void; onToggle(kind: "album" | "song" | "artist", id: string, active: boolean): void; onDelete(kind: "album" | "song" | "artist", id: string): void }) {
  const [start, setStart] = useState(song.previewStart || 0), [end, setEnd] = useState(song.previewEnd || 0), [analyzing, setAnalyzing] = useState(false);
  const analyze = async () => { if (!song.audioUrl) return; setAnalyzing(true); try { const suggestion = await suggestChorus(song.audioUrl); setStart(suggestion.start); setEnd(suggestion.end); } finally { setAnalyzing(false); } };
  return <form className="song-editor" onSubmit={(event) => onSave(event, "song")}><input type="hidden" name="id" value={song.id} /><input type="hidden" name="albumId" value={song.albumId} /><input name="title" defaultValue={song.title} /><label>תחילת פזמון<input name="previewStart" type="number" min="0" value={start} onChange={(e) => setStart(Number(e.target.value))} /></label><label>סיום פזמון<input name="previewEnd" type="number" min="0" value={end} onChange={(e) => setEnd(Number(e.target.value))} /></label>{song.audioUrl && <audio controls preload="none" src={`${song.audioUrl}#t=${start}${end ? `,${end}` : ""}`} />}<button type="button" onClick={analyze}>{analyzing ? "מנתח…" : "הצעה אוטומטית לפזמון"}</button><button>שמירה</button><Toggle active={!!song.active} onClick={() => onToggle("song", song.id, !song.active)} /><button type="button" className="danger" onClick={() => onDelete("song", song.id)}>מחיקה</button></form>;
}

function Results({ data }: { data: Overview["results"] }) { const [kind, setKind] = useState<keyof Overview["results"]>("albums"); const list = data[kind]; return <AdminSection title="תוצאות בזמן אמת"><div className="result-tabs"><button onClick={() => setKind("albums")}>אלבומים</button><button onClick={() => setKind("songs")}>שירים</button><button onClick={() => setKind("artists")}>זמרים</button></div><div className="results-table">{list.map((item, index) => <div key={item.id}><b>{index + 1}</b><span>{item.title || item.name}<small>{item.albumTitle}</small></span><strong>{item.votes} קולות</strong></div>)}</div></AdminSection>; }
function AdminSection({ title, children }: { title: string; children: ReactNode }) { return <section className="admin-panel"><h2>{title}</h2>{children}</section>; }
function Nav({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) { return <button className={active ? "active" : ""} onClick={onClick}>{children}</button>; }
function Toggle({ active, onClick }: { active: boolean; onClick(): void }) { return <button type="button" className={`toggle ${active ? "on" : ""}`} onClick={onClick}>{active ? "פעיל" : "מוסתר"}</button>; }
