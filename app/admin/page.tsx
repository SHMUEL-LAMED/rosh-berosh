"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { LoginScreen, logout, useCurrentUser } from "../auth-ui";

type Album = { id: string; title: string; artistName: string; coverUrl?: string; active: number };
type Song = { id: string; albumId: string; title: string; audioUrl?: string; active: number };
type Artist = { id: string; name: string; imageUrl?: string; active: number };
type Overview = { albums: Album[]; songs: Song[]; artists: Artist[]; votes: { total?: number; phone?: number; site?: number } };

export default function AdminPage() {
  const [user] = useCurrentUser();
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<"albums" | "songs" | "artists">("albums");
  const [message, setMessage] = useState("");
  const load = useCallback(() => fetch("/api/admin/overview", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); setData(await response.json()); }).catch(() => setMessage("לא הצלחנו לטעון את נתוני הניהול.")), []);
  useEffect(() => { if (user?.isAdmin) load(); }, [user, load]);

  if (user === undefined) return <main className="login-shell"><div className="loading">בודקים הרשאות…</div></main>;
  if (!user) return <LoginScreen />;
  if (!user.isAdmin) return <main className="login-shell" dir="rtl"><section className="login-card"><h1>אין גישה לעמוד הזה</h1><p>החשבון הזה אינו מוגדר כמנהל.</p><a className="continue admin-home-link" href="/">חזרה להצבעה</a></section></main>;

  const save = async (event: FormEvent<HTMLFormElement>, kind: "album" | "song" | "artist") => {
    event.preventDefault(); setMessage("שומרים…");
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/admin/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, kind }) });
    const result = await response.json();
    if (!response.ok) return setMessage(result.error);
    event.currentTarget.reset(); setMessage("נשמר בהצלחה."); load();
  };
  const toggle = async (kind: "album" | "song" | "artist", id: string, active: boolean) => {
    await fetch("/api/admin/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, active }) }); load();
  };

  return <main className="admin-shell" dir="rtl">
    <aside className="admin-side"><div className="vote-header"><div className="logo-mark">ר</div><div><strong>ראש בראש</strong><small>מערכת ניהול</small></div></div><nav><button className={tab === "albums" ? "active" : ""} onClick={() => setTab("albums")}>אלבומים</button><button className={tab === "songs" ? "active" : ""} onClick={() => setTab("songs")}>שירים</button><button className={tab === "artists" ? "active" : ""} onClick={() => setTab("artists")}>זמרים</button><a href="/">מעבר לאתר</a></nav><button className="admin-logout" onClick={logout}>יציאה מהחשבון</button></aside>
    <section className="admin-main"><header><div><p className="kicker">שלום, {user.name}</p><h1>מרכז הניהול</h1></div><span>{user.picture && <img src={user.picture} alt="" />}{user.email}</span></header>
      <div className="stat-grid"><article><small>סה״כ הצבעות</small><b>{data?.votes.total ?? 0}</b></article><article><small>הצבעות באתר</small><b>{data?.votes.site ?? 0}</b></article><article><small>הצבעות בטלפון</small><b>{data?.votes.phone ?? 0}</b></article><article><small>פריטים פעילים</small><b>{(data?.albums.filter(x => x.active).length ?? 0) + (data?.songs.filter(x => x.active).length ?? 0) + (data?.artists.filter(x => x.active).length ?? 0)}</b></article></div>
      {message && <p className="admin-message">{message}</p>}
      {tab === "albums" && <AdminSection title="ניהול אלבומים"><form onSubmit={(e) => save(e, "album")}><input name="title" placeholder="שם האלבום" required /><input name="artistName" placeholder="שם האמן" required /><input name="coverUrl" placeholder="קישור לתמונה (לא חובה)" /><button>הוסף אלבום</button></form><div className="admin-list">{data?.albums.map(item => <article key={item.id}><div>{item.coverUrl ? <img src={item.coverUrl} alt="" /> : <i>♫</i>}<span><b>{item.title}</b><small>{item.artistName}</small></span></div><Toggle active={!!item.active} onClick={() => toggle("album", item.id, !item.active)} /></article>)}</div></AdminSection>}
      {tab === "songs" && <AdminSection title="ניהול שירים"><form onSubmit={(e) => save(e, "song")}><select name="albumId" required><option value="">בחר אלבום</option>{data?.albums.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select><input name="title" placeholder="שם השיר" required /><input name="audioUrl" placeholder="קישור לקובץ שמע (לא חובה)" /><button>הוסף שיר</button></form><div className="admin-list">{data?.songs.map(item => <article key={item.id}><div><i>♪</i><span><b>{item.title}</b><small>{data.albums.find(a => a.id === item.albumId)?.title}</small></span></div><Toggle active={!!item.active} onClick={() => toggle("song", item.id, !item.active)} /></article>)}</div></AdminSection>}
      {tab === "artists" && <AdminSection title="ניהול זמרים"><form onSubmit={(e) => save(e, "artist")}><input name="name" placeholder="שם הזמר" required /><input name="imageUrl" placeholder="קישור לתמונה (לא חובה)" /><button>הוסף זמר</button></form><div className="admin-list">{data?.artists.map(item => <article key={item.id}><div>{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <i>{item.name[0]}</i>}<span><b>{item.name}</b><small>זמר</small></span></div><Toggle active={!!item.active} onClick={() => toggle("artist", item.id, !item.active)} /></article>)}</div></AdminSection>}
    </section>
  </main>;
}

function AdminSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="admin-panel"><h2>{title}</h2>{children}</section>; }
function Toggle({ active, onClick }: { active: boolean; onClick(): void }) { return <button className={`toggle ${active ? "on" : ""}`} onClick={onClick}>{active ? "פעיל" : "מוסתר"}</button>; }
