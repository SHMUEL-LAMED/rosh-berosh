"use client";

import { useEffect, useMemo, useState } from "react";

type Album = { id: string; title: string; artistName: string; coverUrl?: string | null };
type Song = { id: string; albumId: string; title: string; audioUrl?: string | null };
type Artist = { id: string; name: string; imageUrl?: string | null };
type Catalog = { albums: Album[]; songs: Song[]; artists: Artist[]; rules: { albums: number; artistsMin: number; artistsMax: number } };

const steps = ["אלבומים", "שירים", "זמרים", "אישור"];

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [step, setStep] = useState(0);
  const [albums, setAlbums] = useState<string[]>([]);
  const [songs, setSongs] = useState<Record<string, string>>({});
  const [artists, setArtists] = useState<string[]>([]);
  const [voterKey, setVoterKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/catalog", { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then(setCatalog)
      .catch(() => setError("לא הצלחנו לטעון את רשימת המצעד. נסו שוב מאוחר יותר."));
  }, []);

  const selectedAlbums = useMemo(() => catalog?.albums.filter((album) => albums.includes(album.id)) ?? [], [catalog, albums]);
  const selectedArtists = useMemo(() => catalog?.artists.filter((artist) => artists.includes(artist.id)) ?? [], [catalog, artists]);
  const songsByAlbum = (albumId: string) => catalog?.songs.filter((song) => song.albumId === albumId) ?? [];
  const songName = (albumId: string) => catalog?.songs.find((song) => song.id === songs[albumId])?.title ?? "לא נבחר";

  const toggleAlbum = (id: string) => {
    setError("");
    if (albums.includes(id)) { setAlbums(albums.filter((item) => item !== id)); setSongs((current) => { const next = { ...current }; delete next[id]; return next; }); return; }
    if (albums.length >= 5) { setError("אפשר לבחור בדיוק חמישה אלבומים."); return; }
    setAlbums([...albums, id]);
  };

  const toggleArtist = (id: string) => {
    setError("");
    if (artists.includes(id)) { setArtists(artists.filter((item) => item !== id)); return; }
    if (artists.length >= 3) { setError("אפשר לבחור עד שלושה זמרים."); return; }
    setArtists([...artists, id]);
  };

  const next = () => {
    setError("");
    if (step === 0 && albums.length !== 5) return setError("כדי להמשיך יש לבחור בדיוק חמישה אלבומים.");
    if (step === 1 && albums.some((id) => !songs[id])) return setError("יש לבחור שיר אחד מכל אלבום.");
    if (step === 2 && (artists.length < 1 || artists.length > 3)) return setError("יש לבחור בין זמר אחד לשלושה.");
    setStep((current) => Math.min(3, current + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async () => {
    if (!voterKey.trim()) return setError("יש להזין מספר טלפון או כתובת אימייל לצורך מניעת הצבעה כפולה.");
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ballots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voterKey, albumIds: albums, songIdsByAlbum: songs, artistIds: artists, channel: "site" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setDone(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "שמירת ההצבעה נכשלה."); }
    finally { setBusy(false); }
  };

  if (done) return <main className="voting-shell"><section className="success-card"><span>✓</span><p className="kicker">ההצבעה נקלטה</p><h1>תודה שהשתתפתם!</h1><p>הבחירות שלכם נשמרו בהצלחה וישוקללו בתוצאות המצעד.</p></section></main>;

  return (
    <main className="voting-shell" dir="rtl">
      <header className="vote-header">
        <div className="logo-mark">ר</div><div><strong>ראש בראש</strong><small>מצעד 25 שנות מוזיקה</small></div>
      </header>

      <section className="hero">
        <p className="kicker">הקול שלכם קובע</p>
        <h1>בוחרים את הגדולים<br />של המוזיקה היהודית</h1>
        <p>בחרו חמישה אלבומים, שיר אהוב מכל אלבום ועד שלושה זמרים.</p>
      </section>

      <ol className="stepper" aria-label="שלבי ההצבעה">
        {steps.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "complete" : ""}><b>{index < step ? "✓" : index + 1}</b><span>{label}</span></li>)}
      </ol>

      <section className="vote-card">
        {!catalog && !error && <div className="loading">טוענים את רשימת המצעד…</div>}
        {catalog && catalog.albums.length === 0 && <div className="empty-catalog"><h2>המצעד בהכנה</h2><p>רשימת האלבומים, השירים והזמרים תעלה בקרוב.</p></div>}

        {catalog && catalog.albums.length > 0 && step === 0 && <>
          <div className="section-title"><div><p className="kicker">שלב ראשון</p><h2>בחרו 5 אלבומים</h2></div><strong>{albums.length}/5</strong></div>
          <div className="album-grid">{catalog.albums.map((album) => <button type="button" key={album.id} className={`choice-card ${albums.includes(album.id) ? "selected" : ""}`} onClick={() => toggleAlbum(album.id)}>{album.coverUrl ? <img src={album.coverUrl} alt="" /> : <span className="cover-fallback">♫</span>}<b>{album.title}</b><small>{album.artistName}</small><i>{albums.includes(album.id) ? "✓" : "+"}</i></button>)}</div>
        </>}

        {catalog && step === 1 && <>
          <div className="section-title"><div><p className="kicker">שלב שני</p><h2>בחרו שיר מכל אלבום</h2></div><strong>{Object.keys(songs).filter((id) => albums.includes(id)).length}/5</strong></div>
          <div className="song-groups">{selectedAlbums.map((album) => <fieldset key={album.id}><legend><b>{album.title}</b><small>{album.artistName}</small></legend>{songsByAlbum(album.id).map((song) => <label key={song.id} className={songs[album.id] === song.id ? "selected" : ""}><input type="radio" name={`album-${album.id}`} checked={songs[album.id] === song.id} onChange={() => setSongs({ ...songs, [album.id]: song.id })} /><span>{song.title}</span>{song.audioUrl && <audio controls preload="none" src={song.audioUrl} />}</label>)}</fieldset>)}</div>
        </>}

        {catalog && step === 2 && <>
          <div className="section-title"><div><p className="kicker">שלב שלישי</p><h2>בחרו עד 3 זמרים</h2></div><strong>{artists.length}/3</strong></div>
          <div className="artist-grid">{catalog.artists.map((artist) => <button type="button" key={artist.id} className={`artist-card ${artists.includes(artist.id) ? "selected" : ""}`} onClick={() => toggleArtist(artist.id)}>{artist.imageUrl ? <img src={artist.imageUrl} alt="" /> : <span>{artist.name.slice(0, 1)}</span>}<b>{artist.name}</b><i>{artists.includes(artist.id) ? "✓" : "+"}</i></button>)}</div>
        </>}

        {catalog && step === 3 && <>
          <div className="section-title"><div><p className="kicker">כמעט סיימנו</p><h2>אישור ההצבעה</h2></div></div>
          <div className="summary"><h3>האלבומים והשירים שבחרתם</h3>{selectedAlbums.map((album) => <div key={album.id}><b>{album.title}</b><span>{songName(album.id)}</span></div>)}<h3>הזמרים שבחרתם</h3><p>{selectedArtists.map((artist) => artist.name).join(" · ")}</p></div>
          <label className="identity-field">מספר טלפון או אימייל<input value={voterKey} onChange={(event) => setVoterKey(event.target.value)} placeholder="למניעת הצבעה כפולה" /><small>הפרט משמש כמזהה הצבעה בלבד. בהמשך יתווסף אימות בקוד חד־פעמי.</small></label>
        </>}

        {error && <p className="vote-error">{error}</p>}
        {catalog && catalog.albums.length > 0 && <footer className="vote-actions">{step > 0 && <button className="back" onClick={() => { setError(""); setStep(step - 1); }}>חזרה</button>}<button className="continue" disabled={busy} onClick={step === 3 ? submit : next}>{busy ? "שומרים…" : step === 3 ? "שליחת ההצבעה" : "המשך"} <span>←</span></button></footer>}
      </section>
    </main>
  );
}
