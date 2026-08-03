"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen, logout, useCurrentUser } from "./auth-ui";

type Album = { id: string; title: string; artistName: string; coverUrl?: string | null };
type Song = { id: string; albumId: string; title: string; audioUrl?: string | null; previewStart?: number; previewEnd?: number };
type Artist = { id: string; name: string; imageUrl?: string | null };
type Rules = { votingOpen: number; albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };
type Catalog = { albums: Album[]; songs: Song[]; artists: Artist[]; rules: Rules };
type Stage = "albums" | "songs" | "artists" | "summary";

const rangeText = (min: number, max: number, noun: string) => min === max ? `${min} ${noun}` : min === 0 ? `עד ${max} ${noun}` : `בין ${min} ל־${max} ${noun}`;

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [songAlbumIndex, setSongAlbumIndex] = useState(0);
  const [albums, setAlbums] = useState<string[]>([]);
  const [songs, setSongs] = useState<Record<string, string[]>>({});
  const [artists, setArtists] = useState<string[]>([]);
  const [player, setPlayer] = useState<Song | null>(null);
  const [user] = useCurrentUser();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { fetch("/api/catalog", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); return response.json(); }).then(setCatalog).catch(() => setError("לא הצלחנו לטעון את רשימת המצעד.")); }, []);
  const stages = useMemo(() => {
    if (!catalog) return [] as { key: Stage; label: string }[];
    return [
      catalog.rules.albumsEnabled && { key: "albums" as Stage, label: "אלבומים" },
      catalog.rules.songsEnabled && { key: "songs" as Stage, label: "שירים" },
      catalog.rules.artistsEnabled && { key: "artists" as Stage, label: "זמרים" },
      { key: "summary" as Stage, label: "אישור" },
    ].filter(Boolean) as { key: Stage; label: string }[];
  }, [catalog]);
  const stage = stages[stageIndex]?.key;
  const selectedAlbums = useMemo(() => catalog?.albums.filter((album) => albums.includes(album.id)) ?? [], [catalog, albums]);
  const selectedArtists = useMemo(() => catalog?.artists.filter((artist) => artists.includes(artist.id)) ?? [], [catalog, artists]);
  const songsByAlbum = (albumId: string) => catalog?.songs.filter((song) => song.albumId === albumId) ?? [];
  const selectedSongNames = (albumId: string) => catalog?.songs.filter((song) => songs[albumId]?.includes(song.id)).map((song) => song.title).join(" · ") || "לא נבחר";

  const toggleLimited = (items: string[], id: string, max: number, set: (next: string[]) => void, message: string) => {
    setError("");
    if (items.includes(id)) return set(items.filter((item) => item !== id));
    if (items.length >= max) return setError(message);
    set([...items, id]);
  };
  const toggleAlbum = (id: string) => {
    if (albums.includes(id)) setSongs((current) => { const next = { ...current }; delete next[id]; return next; });
    toggleLimited(albums, id, catalog?.rules.albumsMax ?? 5, setAlbums, `אפשר לבחור עד ${catalog?.rules.albumsMax ?? 5} אלבומים.`);
  };
  const toggleSong = (albumId: string, songId: string) => {
    const current = songs[albumId] ?? [], max = catalog?.rules.songsMax ?? 1;
    setError("");
    if (current.includes(songId)) return setSongs({ ...songs, [albumId]: current.filter((id) => id !== songId) });
    if (current.length >= max) return setError(`אפשר לבחור עד ${max} שירים מכל אלבום.`);
    setSongs({ ...songs, [albumId]: [...current, songId] });
  };
  const toggleArtist = (id: string) => toggleLimited(artists, id, catalog?.rules.artistsMax ?? 3, setArtists, `אפשר לבחור עד ${catalog?.rules.artistsMax ?? 3} זמרים.`);

  const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  const goToStage = (index: number) => { setStageIndex(Math.max(0, Math.min(stages.length - 1, index))); scrollTop(); };
  const next = () => {
    if (!catalog) return;
    setError("");
    const r = catalog.rules;
    if (stage === "albums") {
      if (albums.length < r.albumsMin || albums.length > r.albumsMax) return setError(`יש לבחור ${rangeText(r.albumsMin, r.albumsMax, "אלבומים")}.`);
      setSongAlbumIndex(0);
      return goToStage(stageIndex + 1);
    }
    if (stage === "songs") {
      const album = selectedAlbums[songAlbumIndex];
      const chosen = album ? (songs[album.id]?.length ?? 0) : 0;
      if (album && (chosen < r.songsMin || chosen > r.songsMax)) return setError(`יש לבחור ${rangeText(r.songsMin, r.songsMax, "שירים")} מ״${album.title}״.`);
      if (songAlbumIndex < selectedAlbums.length - 1) { setSongAlbumIndex(songAlbumIndex + 1); return scrollTop(); }
      return goToStage(stageIndex + 1);
    }
    if (stage === "artists" && (artists.length < r.artistsMin || artists.length > r.artistsMax)) return setError(`יש לבחור ${rangeText(r.artistsMin, r.artistsMax, "זמרים")}.`);
    goToStage(stageIndex + 1);
  };
  const back = () => {
    setError("");
    if (stage === "songs" && songAlbumIndex > 0) { setSongAlbumIndex(songAlbumIndex - 1); return scrollTop(); }
    const target = stageIndex - 1;
    if (target < 0) return;
    if (stages[target]?.key === "songs") setSongAlbumIndex(Math.max(0, selectedAlbums.length - 1));
    goToStage(target);
  };
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ballots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ albumIds: albums, songIdsByAlbum: songs, artistIds: artists, channel: "site" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setDone(true); setPlayer(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "שמירת ההצבעה נכשלה."); } finally { setBusy(false); }
  };

  if (user === undefined) return <main className="login-shell"><div className="loading">בודקים התחברות…</div></main>;
  if (!user) return <LoginScreen />;
  if (done) return <main className="voting-shell"><section className="success-card"><span>✓</span><p className="kicker">ההצבעה נקלטה</p><h1>תודה שהשתתפתם!</h1><p>הבחירות שלכם נשמרו בהצלחה.</p></section></main>;

  return <main className={`voting-shell ${player ? "with-player" : ""}`} dir="rtl">
    <header className="vote-header"><div className="logo-mark">ר</div><div><strong>ראש בראש</strong><small>מצעד המוזיקה הגדול</small></div><nav className="user-nav"><span>{user.picture && <img src={user.picture} alt="" />}{user.name}</span>{user.isAdmin && <a href="/admin">ניהול</a>}<button onClick={logout}>יציאה</button></nav></header>
    <section className="hero"><p className="kicker">הקול שלכם קובע</p><h1>בוחרים את הגדולים<br />של המוזיקה היהודית</h1><p>הצביעו לאלבומים, לשירים ולזמרים האהובים עליכם.</p></section>
    {catalog && !catalog.rules.votingOpen ? <section className="vote-card"><div className="empty-catalog"><h2>ההצבעה סגורה כרגע</h2><p>מנהל המצעד יפתח אותה בקרוב.</p></div></section> : <>
      <ol className="stepper" aria-label="שלבי ההצבעה">{stages.map((item, index) => <li key={item.key} className={index === stageIndex ? "current" : index < stageIndex ? "complete" : ""}><b>{index < stageIndex ? "✓" : index + 1}</b><span>{item.label}</span></li>)}</ol>
      <section className="vote-card">
        {!catalog && !error && <div className="loading">טוענים את רשימת המצעד…</div>}
        {catalog && catalog.albums.length === 0 && <div className="empty-catalog"><h2>המצעד בהכנה</h2><p>התוכן יעלה בקרוב.</p></div>}
        {catalog && stage === "albums" && <><Title kicker="שלב ראשון" title={`בחרו ${rangeText(catalog.rules.albumsMin, catalog.rules.albumsMax, "אלבומים")}`} count={`${albums.length}/${catalog.rules.albumsMax}`} /><div className="album-grid">{catalog.albums.map((album) => <button type="button" key={album.id} className={`choice-card ${albums.includes(album.id) ? "selected" : ""}`} onClick={() => toggleAlbum(album.id)}>{album.coverUrl ? <img src={album.coverUrl} alt="" /> : <span className="cover-fallback">♫</span>}<b>{album.title}</b><small>{album.artistName}</small><i>{albums.includes(album.id) ? "✓" : "+"}</i></button>)}</div></>}
        {catalog && stage === "songs" && (() => {
          const album = selectedAlbums[Math.min(songAlbumIndex, Math.max(0, selectedAlbums.length - 1))];
          if (!album) return <div className="empty-catalog"><h2>עדיין לא נבחרו אלבומים</h2><p>חזרו אחורה ובחרו אלבומים כדי לבחור מהם שירים.</p></div>;
          const chosen = songs[album.id]?.length ?? 0;
          return <><Title kicker={`שלב שני · אלבום ${songAlbumIndex + 1} מתוך ${selectedAlbums.length}`} title={`בחרו ${rangeText(catalog.rules.songsMin, catalog.rules.songsMax, "שירים")} מ״${album.title}״`} count={`${chosen}/${catalog.rules.songsMax}`} />
            <div className="song-progress"><span>{album.artistName}</span><div className="dots">{selectedAlbums.map((item, index) => <i key={item.id} className={index === songAlbumIndex ? "on" : index < songAlbumIndex ? "done" : ""} />)}</div></div>
            <div className="song-groups"><fieldset><legend><b>{album.title}</b><small>{album.artistName}</small></legend>{songsByAlbum(album.id).map((song) => <div key={song.id} className={`song-row ${songs[album.id]?.includes(song.id) ? "selected" : ""}`}><button className="song-select" onClick={() => toggleSong(album.id, song.id)}><i>{songs[album.id]?.includes(song.id) ? "✓" : "+"}</i><span>{song.title}</span></button>{song.audioUrl && <button className="song-play" aria-label={`השמעת ${song.title}`} onClick={() => setPlayer((current) => current?.id === song.id ? null : song)}>{player?.id === song.id ? "■" : "▶"}</button>}</div>)}</fieldset></div></>;
        })()}
        {catalog && stage === "artists" && <><Title kicker="שלב שלישי" title={`בחרו ${rangeText(catalog.rules.artistsMin, catalog.rules.artistsMax, "זמרים")}`} count={`${artists.length}/${catalog.rules.artistsMax}`} /><div className="artist-grid">{catalog.artists.map((artist) => <button type="button" key={artist.id} className={`artist-card ${artists.includes(artist.id) ? "selected" : ""}`} onClick={() => toggleArtist(artist.id)}>{artist.imageUrl ? <img src={artist.imageUrl} alt="" /> : <span>{artist.name.slice(0, 1)}</span>}<b>{artist.name}</b><i>{artists.includes(artist.id) ? "✓" : "+"}</i></button>)}</div></>}
        {catalog && stage === "summary" && <><Title kicker="כמעט סיימנו" title="אישור ההצבעה" /><div className="summary">{catalog.rules.albumsEnabled ? <><h3>האלבומים והשירים שבחרתם</h3>{selectedAlbums.map((album) => <div key={album.id}><b>{album.title}</b><span>{selectedSongNames(album.id)}</span></div>)}</> : null}{catalog.rules.artistsEnabled ? <><h3>הזמרים שבחרתם</h3><p>{selectedArtists.map((artist) => artist.name).join(" · ")}</p></> : null}</div><div className="signed-voter"><span>ההצבעה תישמר עבור</span><b>{user.email}</b></div></>}
        {error && <p className="vote-error">{error}</p>}
        {catalog && catalog.albums.length > 0 && <footer className="vote-actions">{(stageIndex > 0 || songAlbumIndex > 0) && <button className="back" onClick={back}>חזרה</button>}<button className="continue" disabled={busy} onClick={stage === "summary" ? submit : next}>{busy ? "שומרים…" : stage === "summary" ? "שליחת ההצבעה" : "המשך"} <span>←</span></button></footer>}
      </section>
    </>}
    {player && <AudioPlayer song={player} onClose={() => setPlayer(null)} />}
  </main>;
}

function Title({ kicker, title, count }: { kicker: string; title: string; count?: string }) { return <div className="section-title"><div><p className="kicker">{kicker}</p><h2>{title}</h2></div>{count && <strong>{count}</strong>}</div>; }

function AudioPlayer({ song, onClose }: { song: Song; onClose(): void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const start = Math.max(0, song.previewStart ?? 0);
  const configuredEnd = Math.max(start, song.previewEnd ?? 0);
  const end = configuredEnd > start ? configuredEnd : duration;
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    setCurrent(start); setPlaying(false);
    const begin = () => { setDuration(element.duration || 0); element.currentTime = start; setCurrent(start); element.play().then(() => setPlaying(true)).catch(() => undefined); };
    element.addEventListener("loadedmetadata", begin, { once: true });
    return () => { element.pause(); };
  }, [song, start]);
  const toggle = () => { const element = audio.current; if (!element) return; if (element.paused) { if (element.currentTime >= end) element.currentTime = start; element.play().then(() => setPlaying(true)).catch(() => undefined); } else { element.pause(); setPlaying(false); } };
  const seek = (value: number) => { if (!audio.current) return; audio.current.currentTime = value; setCurrent(value); };
  const changeVolume = (value: number) => { if (audio.current) audio.current.volume = value; setVolume(value); };
  return <div className="audio-dock"><audio ref={audio} key={song.id} src={song.audioUrl ?? ""} preload="metadata" onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => { const value = event.currentTarget.currentTime; setCurrent(value); if (configuredEnd > start && value >= configuredEnd) { event.currentTarget.pause(); event.currentTarget.currentTime = start; setCurrent(start); setPlaying(false); } }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /><button className="player-close" onClick={onClose} aria-label="סגירת הנגן">×</button><button className="player-main" onClick={toggle} aria-label={playing ? "השהיה" : "נגינה"}>{playing ? "❚❚" : "▶"}</button><div className="player-copy"><small>{configuredEnd > start ? "קטע נבחר" : "השיר המלא"}</small><b>{song.title}</b></div><div className="player-progress"><input aria-label="מיקום בשיר" type="range" min={start} max={Math.max(start + 1, end || duration || 1)} step="0.1" value={Math.min(current, Math.max(start + 1, end || duration || 1))} onChange={(event) => seek(Number(event.target.value))} /><span>{formatPlayerTime(current - start)} / {formatPlayerTime(Math.max(0, end - start))}</span></div><label className="player-volume" aria-label="עוצמת שמע">🔊<input type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></label></div>;
}

function formatPlayerTime(value: number) { if (!Number.isFinite(value) || value < 0) return "0:00"; return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
