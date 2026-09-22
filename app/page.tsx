"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen, logout, useCurrentUser } from "./auth-ui";
import { useNotice } from "./notice";
import { usePlayer } from "./player-context";
import { SubscribeAfterLogin, SubscribeCard } from "./subscribe";
import { hasStageChoices } from "./voting-stage.js";

type Album = { id: string; title: string; artistName: string; coverUrl?: string | null };
type Song = { id: string; albumId: string; title: string; audioUrl?: string | null; coverUrl?: string | null; previewStart?: number; previewEnd?: number };
type Artist = { id: string; name: string; imageUrl?: string | null };
type Rules = { votingOpen: number; albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };
type Catalog = { surveyId: string; albums: Album[]; songs: Song[]; artists: Artist[]; rules: Rules };
type Stage = "albums" | "songs" | "artists" | "summary";
// זמני ההצבעה: מתי התחילו, מתי הושלם כל שלב בפעם הראשונה, ובכמה ביקורים.
// נשמרים יחד עם ההתקדמות כדי שרענון או חזרה מאוחרת ימשיכו את אותה מדידה.
type VoteTiming = { startedAt: number; albumsDoneAt?: number; songsDoneAt?: number; artistsDoneAt?: number; sessions: number };
type SavedProgress = { albumIds?: string[]; songIdsByAlbum?: Record<string, string[]>; artistIds?: string[]; stageIndex?: number; songAlbumIndex?: number; timing?: Partial<VoteTiming> };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const VISIT_KEY = "rosh-berosh-visit-counted";
/**
 * "ביקור" הוא כניסה חדשה, לא רינדור ולא רענון. sessionStorage חי בדיוק
 * לאורך הלשונית, ולכן רענון של אותה לשונית אינו מוסיף ביקור ולשונית חדשה
 * כן. אחסון חסום מחזיר ספירה של ביקור אחד במקום להפיל את המדידה.
 */
function countVisit(): boolean {
  try {
    if (window.sessionStorage.getItem(VISIT_KEY)) return false;
    window.sessionStorage.setItem(VISIT_KEY, "1");
    return true;
  } catch { return true; }
}
function restoreTiming(saved?: Partial<VoteTiming> | null, fresh = countVisit()): VoteTiming {
  const startedAt = Number(saved?.startedAt) > 0 ? Number(saved!.startedAt) : nowSeconds();
  const stamp = (value: unknown) => (Number(value) >= startedAt ? Number(value) : undefined);
  const previous = Number(saved?.sessions) > 0 ? Number(saved!.sessions) : 0;
  return { startedAt, albumsDoneAt: stamp(saved?.albumsDoneAt), songsDoneAt: stamp(saved?.songsDoneAt), artistsDoneAt: stamp(saved?.artistsDoneAt), sessions: Math.max(1, previous + (fresh ? 1 : 0)) };
}
type ReceiptAlbum = { id: string; title: string; artistName: string; coverUrl?: string | null; songs: string[] };
type ReceiptArtist = { id: string; name: string; imageUrl?: string | null };
type Receipt = { albums: ReceiptAlbum[]; artists: ReceiptArtist[] };

const rangeText = (min: number, max: number, noun: string) => min === max ? `${min} ${noun}` : min === 0 ? `עד ${max} ${noun}` : `בין ${min} ל־${max} ${noun}`;

async function browserFingerprint(): Promise<string> {
  const signals = [
    navigator.language,
    navigator.languages?.join(","),
    screen.width + "x" + screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency,
    navigator.maxTouchPoints,
    navigator.platform,
  ];
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      canvas.width = 200; canvas.height = 50;
      ctx.textBaseline = "top";
      ctx.font = "14px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(40, 0, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("fingerprint", 2, 15);
      ctx.fillStyle = "rgba(102,204,0,0.7)";
      ctx.fillText("fingerprint", 4, 17);
      signals.push(canvas.toDataURL());
    }
  } catch { /* canvas not available */ }
  const data = new TextEncoder().encode(signals.join("|"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type SharedBannerData = { text: string; link: string; linkLabel: string };
/** ההודעה המשותפת: מנהל כותב אותה באתר התוכניות ומסמן "גם באתר הסקר". */
function SharedBanner() {
  const [banner, setBanner] = useState<SharedBannerData | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/program/banner", { cache: "no-store" }).then(async (response) => response.ok ? (await response.json()).banner as SharedBannerData | null : null).then((value) => { if (active) setBanner(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!banner?.text) return null;
  return <div className="shared-banner" role="status"><span aria-hidden="true">✦</span><p>{banner.text}</p>{banner.link && <a href={banner.link} target={/^https?:/.test(banner.link) ? "_blank" : undefined} rel="noopener">{banner.linkLabel || "לפרטים"} ←</a>}</div>;
}

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [songAlbumIndex, setSongAlbumIndex] = useState(0);
  const [albums, setAlbums] = useState<string[]>([]);
  const [songs, setSongs] = useState<Record<string, string[]>>({});
  const [artists, setArtists] = useState<string[]>([]);
  const [timing, setTiming] = useState<VoteTiming | null>(null);
  const { song: player, play, stop, setSiblings } = usePlayer();
  const [user] = useCurrentUser();
  const requestedPreview = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("preview") : null;
  const preview = !!user?.isAdmin && (requestedPreview === "site" || requestedPreview === "ivr");
  const ivrPreview = preview && requestedPreview === "ivr";
  const { notify, clear: clearNotice } = useNotice();
  const fail = (text: string) => notify(text, "error");
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [voted, setVoted] = useState<boolean | null>(null);
  const [savedReceipt, setSavedReceipt] = useState<Receipt | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [voteCheckFailed, setVoteCheckFailed] = useState(false);
  const progressReady = useRef(false);
  const loadedMediaAlbums = useRef(new Set<string>());
  const loadingMediaAlbums = useRef(new Set<string>());

  const loadCatalog = useCallback(async () => {
    setLoadFailed(false);
    try {
      const response = await fetch("/api/catalog", { cache: "no-store" });
      if (!response.ok) throw new Error();
      loadedMediaAlbums.current.clear();
      loadingMediaAlbums.current.clear();
      setCatalog(await response.json());
    } catch {
      setLoadFailed(true);
      notify("לא הצלחנו לטעון את רשימת המצעד.", "error");
    }
  }, [notify]);
  const loadSongMedia = useCallback(async (albumIds: string[]) => {
    const wanted = [...new Set(albumIds)].filter((id) => !loadedMediaAlbums.current.has(id) && !loadingMediaAlbums.current.has(id));
    if (!wanted.length) return;
    wanted.forEach((id) => loadingMediaAlbums.current.add(id));
    try {
      const response = await fetch(`/api/catalog/media?albumIds=${encodeURIComponent(wanted.join(","))}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = await response.json() as { songs?: Array<Pick<Song, "id" | "audioUrl" | "coverUrl" | "previewStart" | "previewEnd">> };
      const media = new Map((body.songs || []).map((song) => [song.id, song]));
      setCatalog((current) => current ? { ...current, songs: current.songs.map((song) => ({ ...song, ...media.get(song.id) })) } : current);
      wanted.forEach((id) => loadedMediaAlbums.current.add(id));
    } catch {
      wanted.forEach((id) => loadedMediaAlbums.current.delete(id));
    } finally {
      wanted.forEach((id) => loadingMediaAlbums.current.delete(id));
    }
  }, []);
  const checkVote = useCallback(async () => {
    setVoted(null); setVoteCheckFailed(false);
    try {
      const fp = await browserFingerprint().catch(() => "");
      const response = await fetch(`/api/ballots/check${fp ? `?fingerprint=${encodeURIComponent(fp)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = await response.json();
      setBlocked(!!body.blocked);
      setVoted(!!body.voted);
      setSavedReceipt(body.receipt || null);
    } catch {
      setVoteCheckFailed(true);
    }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void loadCatalog(), 0); return () => window.clearTimeout(timer); }, [loadCatalog]);
  useEffect(() => {
    if (!user) return;
    if (preview) {
      progressReady.current = true;
      const timer = window.setTimeout(() => { setBlocked(false); setVoted(false); }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => void checkVote(), 0);
    return () => window.clearTimeout(timer);
  }, [user, preview, checkVote]);

  useEffect(() => {
    if (preview || !catalog || voted !== false || progressReady.current) return;
    progressReady.current = true;
    fetch("/api/ballots/progress", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      return response.json() as Promise<{ progress?: SavedProgress | null }>;
    }).then(({ progress }) => {
      setTiming(restoreTiming(progress?.timing));
      if (!progress) return;
      const albumSet = new Set(catalog.albums.map((item) => item.id));
      const artistSet = new Set(catalog.artists.map((item) => item.id));
      const songAlbum = new Map(catalog.songs.map((item) => [item.id, item.albumId]));
      const restoredAlbums = (progress.albumIds || []).filter((id) => albumSet.has(id)).slice(0, catalog.rules.albumsMax);
      const restoredSongs: Record<string, string[]> = {};
      for (const albumId of restoredAlbums) restoredSongs[albumId] = (progress.songIdsByAlbum?.[albumId] || []).filter((id) => songAlbum.get(id) === albumId).slice(0, catalog.rules.songsMax);
      setAlbums(restoredAlbums);
      setSongs(restoredSongs);
      setArtists((progress.artistIds || []).filter((id) => artistSet.has(id)).slice(0, catalog.rules.artistsMax));
      const stageCount = [catalog.rules.albumsEnabled, catalog.rules.songsEnabled, catalog.rules.artistsEnabled].filter(Boolean).length + 1;
      setStageIndex(Math.max(0, Math.min(stageCount - 1, Number(progress.stageIndex) || 0)));
      setSongAlbumIndex(Math.max(0, Math.min(restoredAlbums.length - 1, Number(progress.songAlbumIndex) || 0)));
    }).catch(() => {
      // בלי הנפילה לאחור כאן מדידת הזמן נשארת ריקה לכל אורך הביקור, ואיתה
      // גם שמירת ההתקדמות — האפקט שמטה מותנה בקיומה.
      setTiming((current) => current ?? restoreTiming(null));
      notify("לא הצלחנו לשחזר את ההתקדמות השמורה.", "error");
    });
  }, [catalog, voted, preview, notify]);

  useEffect(() => {
    if (preview || !catalog || voted !== false || !progressReady.current || done || !timing) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/ballots/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ albumIds: albums, songIdsByAlbum: songs, artistIds: artists, stageIndex, songAlbumIndex, timing }) });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [catalog, voted, preview, done, albums, songs, artists, stageIndex, songAlbumIndex, timing]);
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
  const stageHasChoices = hasStageChoices(stage, catalog, selectedAlbums.length);
  const songsByAlbum = (albumId: string) => catalog?.songs.filter((song) => song.albumId === albumId) ?? [];
  const selectedSongNames = (albumId: string) => catalog?.songs.filter((song) => songs[albumId]?.includes(song.id)).map((song) => song.title).join(" · ") || "לא נבחר";

  useEffect(() => {
    if (stage === "songs") void loadSongMedia(selectedAlbums.map((album) => album.id));
  }, [stage, selectedAlbums, loadSongMedia]);

  const toggleLimited = (items: string[], id: string, max: number, set: (next: string[]) => void, message: string) => {
    clearNotice();
    if (items.includes(id)) return set(items.filter((item) => item !== id));
    if (items.length >= max) return fail(message);
    set([...items, id]);
  };
  const toggleAlbum = (id: string) => {
    if (albums.includes(id)) setSongs((current) => { const next = { ...current }; delete next[id]; return next; });
    toggleLimited(albums, id, catalog?.rules.albumsMax ?? 5, setAlbums, `אפשר לבחור עד ${catalog?.rules.albumsMax ?? 5} אלבומים.`);
  };
  const toggleSong = (albumId: string, songId: string) => {
    const current = songs[albumId] ?? [], max = catalog?.rules.songsMax ?? 1;
    clearNotice();
    if (current.includes(songId)) return setSongs({ ...songs, [albumId]: current.filter((id) => id !== songId) });
    if (current.length >= max) return fail(`אפשר לבחור עד ${max} שירים מכל אלבום.`);
    setSongs({ ...songs, [albumId]: [...current, songId] });
  };
  const toggleArtist = (id: string) => toggleLimited(artists, id, catalog?.rules.artistsMax ?? 3, setArtists, `אפשר לבחור עד ${catalog?.rules.artistsMax ?? 3} זמרים.`);

  const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  // סיום שלב נמדד בפעם הראשונה שעוברים ממנו הלאה; חזרה אחורה אינה מאפסת אותו.
  const markStageDone = (key: "albumsDoneAt" | "songsDoneAt" | "artistsDoneAt") => setTiming((current) => current && !current[key] ? { ...current, [key]: nowSeconds() } : current);
  const goToStage = (index: number) => { setStageIndex(Math.max(0, Math.min(stages.length - 1, index))); scrollTop(); };
  const next = () => {
    if (!catalog) return;
    clearNotice();
    const r = catalog.rules;
    if (stage === "albums") {
      // Fewer active albums than albumsMin (one deactivated mid-poll) used to
      // freeze the voter on this step. Ask only for what the list actually has.
      const albumsRequired = Math.min(r.albumsMin, catalog.albums.length);
      if (albums.length < albumsRequired || albums.length > r.albumsMax) return fail(`יש לבחור ${rangeText(albumsRequired, Math.min(r.albumsMax, catalog.albums.length), "אלבומים")}.`);
      setSongAlbumIndex(0);
      markStageDone("albumsDoneAt");
      return goToStage(stageIndex + 1);
    }
    if (stage === "songs") {
      const album = selectedAlbums[songAlbumIndex];
      const chosen = album ? (songs[album.id]?.length ?? 0) : 0;
      // An album may hold fewer active songs than songsMin, and then the voter
      // could never clear this step. Ask only for what the album actually has.
      const available = album ? songsByAlbum(album.id).length : 0;
      const required = Math.min(r.songsMin, available);
      if (album && (chosen < required || chosen > r.songsMax)) return fail(`יש לבחור ${rangeText(required, Math.min(r.songsMax, available), "שירים")} מ״${album.title}״.`);
      if (songAlbumIndex < selectedAlbums.length - 1) { setSongAlbumIndex(songAlbumIndex + 1); return scrollTop(); }
      markStageDone("songsDoneAt");
      return goToStage(stageIndex + 1);
    }
    // Same for the singers: a short list must not become a dead end.
    const artistsRequired = Math.min(r.artistsMin, catalog.artists.length);
    if (stage === "artists" && (artists.length < artistsRequired || artists.length > r.artistsMax)) return fail(`יש לבחור ${rangeText(artistsRequired, Math.min(r.artistsMax, catalog.artists.length), "זמרים")}.`);
    if (stage === "artists") markStageDone("artistsDoneAt");
    goToStage(stageIndex + 1);
  };
  const back = () => {
    clearNotice();
    if (stage === "songs" && songAlbumIndex > 0) { setSongAlbumIndex(songAlbumIndex - 1); return scrollTop(); }
    const target = stageIndex - 1;
    if (target < 0) return;
    if (stages[target]?.key === "songs") setSongAlbumIndex(Math.max(0, selectedAlbums.length - 1));
    goToStage(target);
  };
  const submit = async () => {
    setBusy(true); clearNotice();
    try {
      if (preview) { setDone(true); stop(); return; }
      const fp = await browserFingerprint().catch(() => "");
      const response = await fetch("/api/ballots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ albumIds: albums, songIdsByAlbum: songs, artistIds: artists, channel: "site", fingerprint: fp, timing: timing && { ...timing, clientNow: nowSeconds() } }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) setVoted(true);
        throw new Error(result.error);
      }
      setDone(true); stop();
    } catch (caught) { notify(caught instanceof Error ? caught.message : "שמירת ההצבעה נכשלה.", "error"); } finally { setBusy(false); }
  };

  if (user === undefined) return <main className="login-shell"><div className="loading">בודקים התחברות…</div></main>;
  if (!user) return <LoginScreen />;
  if (!preview && voteCheckFailed) return <main className="login-shell"><section className="success-card"><h1>לא הצלחנו לבדוק את ההצבעה</h1><p>לא נציג את טופס ההצבעה לפני שנדע אם כבר הצבעתם.</p><button className="continue" onClick={checkVote}>ניסיון חוזר</button></section></main>;
  if (voted === null) return <main className="login-shell"><div className="loading">בודקים אם כבר הצבעתם…</div></main>;
  if (!preview && blocked) return <main className="login-shell"><section className="success-card"><h1>המחשב נחסם מהצבעה</h1><p>אי אפשר לשלוח הצבעה נוספת מהמחשב הזה בסקר הנוכחי.</p></section></main>;
  if (done && catalog) return <main className="voting-shell"><section className="success-card receipt-success"><span>✓</span><p className="kicker">{preview ? "התצוגה המקדימה הסתיימה" : "ההצבעה נקלטה"}</p><h1>{preview ? "הגעתם עד השלב האחרון" : "תודה שהשתתפתם!"}</h1><p>{preview ? "זו הייתה הדגמה בלבד. שום הצבעה או התקדמות לא נשמרו." : "הבחירות שלכם נשמרו בהצלחה."}</p><VoteReceipt albums={selectedAlbums.map((album) => ({ id: album.id, title: album.title, artistName: album.artistName, coverUrl: album.coverUrl, songs: selectedSongNames(album.id) === "לא נבחר" ? [] : selectedSongNames(album.id).split(" · ") }))} artists={selectedArtists.map((artist) => ({ id: artist.id, name: artist.name, imageUrl: artist.imageUrl }))} />{preview ? <div className="preview-finish-actions"><button className="continue" onClick={() => { setDone(false); setStageIndex(0); setSongAlbumIndex(0); setAlbums([]); setSongs({}); setArtists([]); }}>התחלת תצוגה מחדש</button><a className="back" href="/admin">חזרה לניהול</a></div> : <SubscribeCard />}</section></main>;

  return <main className={`voting-shell ${player ? "with-player" : ""} ${preview ? `preview-mode preview-${stage}` : ""}`} dir="rtl">
    <SharedBanner />
    {!preview && <SubscribeAfterLogin />}
    {preview && <div className={`preview-banner${ivrPreview ? " ivr" : ""}`}><b>{ivrPreview ? "תצוגה מקדימה של קו ההצבעה" : "תצוגה מקדימה של האתר"}</b><span>{ivrPreview ? "השלבים והכמויות זהים לקו; במקום מקשי הטלפון בוחרים כאן בלחיצה." : "אפשר לעבור עד הסוף. שום בחירה לא תישמר כהצבעה."}</span><a href="/admin">יציאה לניהול</a></div>}
    <header className="vote-header"><img className="logo-mark" src="/badge.jpg" alt="ראש בראש" /><div><strong>ראש בראש</strong><small>מצעד המוזיקה הגדול</small></div><nav className="user-nav"><span>{user.picture && <img src={user.picture} alt="" />}{user.name}</span>{user.isAdmin && <a href="/admin">ניהול</a>}<button onClick={logout}>החלפת חשבון</button></nav></header>
    <section className="hero"><img className="hero-logo" src="/badge.jpg" alt="מצעד האלבומים · 25 שנות מוזיקה" /><p className="kicker"><span>הקול שלכם קובע</span></p><h1 className="parade-title"><span className="hero-line1">מצעד האלבומים</span><span className="hero-divider" aria-hidden="true"></span><span className="hero-line2"><b>25</b><small>שנות מוזיקה</small></span></h1><p>הצביעו לאלבומים, לשירים ולזמרים האהובים עליכם.</p></section>
    {!preview && voted ? <section className="vote-card voted-card"><div className="voted-message"><span className="voted-check" aria-hidden="true">✓</span><p className="kicker">ההצבעה נקלטה</p><h2>כבר הצבעתם בסקר הזה</h2><p>הבחירה שלכם שמורה כאן ואפשר לשתף אותה בכל זמן.</p>{savedReceipt && <VoteReceipt albums={savedReceipt.albums} artists={savedReceipt.artists} />}<SubscribeCard /></div></section> : catalog && !catalog.rules.votingOpen && !preview ? <section className="vote-card"><div className="empty-catalog"><h2>ההצבעה סגורה כרגע</h2><p>מנהל המצעד יפתח אותה בקרוב.</p></div></section> : <>
      <ol className="stepper" aria-label="שלבי ההצבעה">{stages.map((item, index) => <li key={item.key} className={index === stageIndex ? "current" : index < stageIndex ? "complete" : ""}><b>{index < stageIndex ? "✓" : index + 1}</b><span>{item.label}</span></li>)}</ol>
      <section className="vote-card">
        {!catalog && !loadFailed && <div className="loading">טוענים את רשימת המצעד…</div>}
        {!catalog && loadFailed && <div className="empty-catalog"><h2>טעינת רשימת המצעד נכשלה</h2><p>בדקו את החיבור ונסו שוב.</p><button className="continue" onClick={loadCatalog}>ניסיון חוזר</button></div>}
        {catalog && stage === "albums" && catalog.albums.length === 0 && <div className="empty-catalog"><h2>רשימת האלבומים בהכנה</h2><p>האלבומים יעלו בקרוב.</p></div>}
        {catalog && stage === "artists" && catalog.artists.length === 0 && <div className="empty-catalog"><h2>רשימת הזמרים בהכנה</h2><p>הזמרים יעלו בקרוב.</p></div>}
        {catalog && stage === "albums" && <><Title kicker="שלב ראשון" title={`בחרו ${rangeText(catalog.rules.albumsMin, catalog.rules.albumsMax, "אלבומים")}`} count={`${albums.length}/${catalog.rules.albumsMax}`} /><div className="album-grid">{catalog.albums.map((album) => <button type="button" key={album.id} aria-pressed={albums.includes(album.id)} className={`choice-card ${albums.includes(album.id) ? "selected" : ""}`} onClick={() => toggleAlbum(album.id)}>{album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.nextElementSibling?.classList.remove("hidden-fallback"); }} /> : null}<span className={`cover-fallback${album.coverUrl ? " hidden-fallback" : ""}`}>♫</span><b>{album.title}</b><small>{album.artistName}</small><i aria-hidden="true">{albums.includes(album.id) ? "✓" : "+"}</i></button>)}</div></>}
        {catalog && stage === "songs" && (() => {
          const album = selectedAlbums[Math.min(songAlbumIndex, Math.max(0, selectedAlbums.length - 1))];
          if (!album) return <div className="empty-catalog"><h2>עדיין לא נבחרו אלבומים</h2><p>חזרו אחורה ובחרו אלבומים כדי לבחור מהם שירים.</p></div>;
          const chosen = songs[album.id]?.length ?? 0;
          return <><Title kicker={`שלב שני · אלבום ${songAlbumIndex + 1} מתוך ${selectedAlbums.length}`} title={`בחרו ${rangeText(catalog.rules.songsMin, catalog.rules.songsMax, "שירים")} מ״${album.title}״`} count={`${chosen}/${catalog.rules.songsMax}`} />
            <div className="song-progress"><span>{album.artistName}</span><div className="dots">{selectedAlbums.map((item, index) => <i key={item.id} className={index === songAlbumIndex ? "on" : index < songAlbumIndex ? "done" : ""} />)}</div></div>
            <div className="song-groups"><fieldset><legend><b>{album.title}</b><small>{album.artistName}</small></legend>{songsByAlbum(album.id).map((song) => <div key={song.id} className={`song-row ${songs[album.id]?.includes(song.id) ? "selected" : ""}`}><button type="button" className="song-select" aria-pressed={songs[album.id]?.includes(song.id) ?? false} onClick={() => toggleSong(album.id, song.id)}><i aria-hidden="true">{songs[album.id]?.includes(song.id) ? "✓" : "+"}</i><span>{song.title}</span></button>{song.audioUrl && <button type="button" className="song-play" aria-label={`השמעת ${song.title}`} onClick={() => { setSiblings(songsByAlbum(album.id).filter(s => s.audioUrl)); play(song); }}>{player?.id === song.id ? "■" : "▶"}</button>}</div>)}</fieldset></div></>;
        })()}
        {catalog && stage === "artists" && <><Title kicker="שלב שלישי" title={`בחרו ${rangeText(catalog.rules.artistsMin, catalog.rules.artistsMax, "זמרים")}`} count={`${artists.length}/${catalog.rules.artistsMax}`} /><div className="artist-grid">{catalog.artists.map((artist) => <button type="button" key={artist.id} aria-pressed={artists.includes(artist.id)} className={`artist-card ${artists.includes(artist.id) ? "selected" : ""}`} onClick={() => toggleArtist(artist.id)}>{artist.imageUrl ? <img src={artist.imageUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.nextElementSibling?.classList.remove("hidden-fallback"); }} /> : null}<span className={`artist-initial${artist.imageUrl ? " hidden-fallback" : ""}`}>{artist.name.slice(0, 1)}</span><b>{artist.name}</b><i aria-hidden="true">{artists.includes(artist.id) ? "✓" : "+"}</i></button>)}</div></>}
        {catalog && stage === "summary" && <><Title kicker="כמעט סיימנו" title="אישור ההצבעה" /><div className="summary">{catalog.rules.albumsEnabled ? <><h3>האלבומים והשירים שבחרתם</h3><div className="summary-albums">{selectedAlbums.map((album) => <div key={album.id} className="summary-album">{album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.nextElementSibling?.classList.remove("hidden-fallback"); }} /> : null}<span className={`cover-fallback${album.coverUrl ? " hidden-fallback" : ""}`}>♫</span><div><b>{album.title}</b><small>{album.artistName}</small><span>{selectedSongNames(album.id)}</span></div></div>)}</div></> : null}{catalog.rules.artistsEnabled ? <><h3>הזמרים שבחרתם</h3><div className="summary-artists">{selectedArtists.map((artist) => <div key={artist.id} className="summary-artist">{artist.imageUrl ? <img src={artist.imageUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.nextElementSibling?.classList.remove("hidden-fallback"); }} /> : null}<span className={`artist-initial${artist.imageUrl ? " hidden-fallback" : ""}`}>{artist.name.slice(0, 1)}</span><b>{artist.name}</b></div>)}</div></> : null}</div><div className="signed-voter"><span>ההצבעה תישמר עבור</span><b>{user.email}</b></div></>}
        {catalog && stageHasChoices && <footer className="vote-actions">{(stageIndex > 0 || songAlbumIndex > 0) && <button className="back" onClick={back}>חזרה</button>}<button className="continue" disabled={busy} onClick={stage === "summary" ? submit : next}>{busy ? "שומרים…" : stage === "summary" ? "שליחת ההצבעה" : "המשך"} <span>←</span></button></footer>}
      </section>
    </>}
    {catalog && catalog.songs.length > 0 && <BrowsePanel catalog={catalog} loadSongMedia={loadSongMedia} />}
  </main>;
}

type LoadedReceiptImage = { image: CanvasImageSource; width: number; height: number; cleanup(): void };

async function loadReceiptImage(src?: string | null): Promise<LoadedReceiptImage | null> {
  if (!src) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(src, { signal: controller.signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() };
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    return { image, width: image.naturalWidth, height: image.naturalHeight, cleanup: () => URL.revokeObjectURL(url) };
  } catch { return null; }
  finally { window.clearTimeout(timeout); }
}

function drawReceiptImage(ctx: CanvasRenderingContext2D, loaded: LoadedReceiptImage | null, x: number, y: number, width: number, height: number, radius: number, fallback: string, circle = false) {
  ctx.save();
  ctx.beginPath();
  if (circle) ctx.arc(x + width / 2, y + height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
  else ctx.roundRect(x, y, width, height, radius);
  ctx.clip();
  if (loaded) {
    const scale = Math.max(width / loaded.width, height / loaded.height);
    const drawnWidth = loaded.width * scale, drawnHeight = loaded.height * scale;
    ctx.drawImage(loaded.image, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  } else {
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, "#302750"); gradient.addColorStop(1, "#a5862d");
    ctx.fillStyle = gradient; ctx.fillRect(x, y, width, height);
    ctx.direction = "rtl"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff"; ctx.font = `900 ${Math.round(Math.min(width, height) * .42)}px Arial`;
    ctx.fillText(fallback, x + width / 2, y + height / 2);
  }
  ctx.restore();
}

function receiptText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

async function buildReceiptFile(albums: ReceiptAlbum[], artists: ReceiptArtist[]) {
    const width = 1080, albumRows = Math.ceil(albums.length / 2), artistRows = Math.ceil(artists.length / 4);
    const albumSection = albums.length ? 80 + albumRows * 205 : 0;
    const artistSection = artists.length ? 90 + artistRows * 205 : 0;
    const height = Math.max(1350, 485 + albumSection + artistSection);
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("לא ניתן ליצור את הכרטיס.");
    const loadedAlbums = await Promise.all(albums.map((album) => loadReceiptImage(album.coverUrl)));
    const loadedArtists = await Promise.all(artists.map((artist) => loadReceiptImage(artist.imageUrl)));
    const loaded = [...loadedAlbums, ...loadedArtists].filter(Boolean) as LoadedReceiptImage[];
    try {
      const gradient = ctx.createLinearGradient(0, 0, width, height); gradient.addColorStop(0, "#151027"); gradient.addColorStop(.58, "#312653"); gradient.addColorStop(1, "#9d7b1e");
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgba(255,255,255,.07)"; ctx.beginPath(); ctx.arc(95, 155, 270, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(1015, 55, 190, 0, Math.PI * 2); ctx.fill();
      ctx.direction = "rtl"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#ead47a"; ctx.font = "800 32px Arial"; ctx.fillText("הקול שלי במצעד", width / 2, 86);
      ctx.fillStyle = "#fff"; ctx.font = "900 78px Arial"; ctx.fillText("ראש בראש", width / 2, 178);
      ctx.fillStyle = "#f2e8bd"; ctx.font = "700 30px Arial"; ctx.fillText("25 שנות מוזיקה יהודית", width / 2, 228);
      ctx.fillStyle = "rgba(255,255,255,.97)"; ctx.beginPath(); ctx.roundRect(48, 280, width - 96, height - 390, 38); ctx.fill();
      let y = 345;
      if (albums.length) {
        ctx.textAlign = "right"; ctx.fillStyle = "#8b6f18"; ctx.font = "900 34px Arial"; ctx.fillText("האלבומים והשירים שבחרתי", width - 88, y); y += 50;
        const gap = 18, cardWidth = (width - 176 - gap) / 2, cardHeight = 185;
        for (const [index, album] of albums.entries()) {
          const column = index % 2, row = Math.floor(index / 2);
          const x = 79 + column * (cardWidth + gap), cardY = y + row * 205;
          ctx.fillStyle = "#f7f2e2"; ctx.beginPath(); ctx.roundRect(x, cardY, cardWidth, cardHeight, 22); ctx.fill();
          const imageX = x + cardWidth - 163;
          drawReceiptImage(ctx, loadedAlbums[index], imageX, cardY + 14, 142, 157, 17, "♫");
          const textRight = imageX - 18, textWidth = cardWidth - 195;
          ctx.textAlign = "right"; ctx.fillStyle = "#2b2340"; ctx.font = "900 25px Arial";
          ctx.fillText(receiptText(ctx, album.title, textWidth), textRight, cardY + 52);
          ctx.fillStyle = "#746a7d"; ctx.font = "700 19px Arial";
          ctx.fillText(receiptText(ctx, album.artistName, textWidth), textRight, cardY + 83);
          ctx.fillStyle = "#9a771b"; ctx.font = "700 18px Arial";
          const songText = album.songs.length ? album.songs.join(" · ") : "ללא בחירת שיר";
          ctx.fillText(receiptText(ctx, songText, textWidth), textRight, cardY + 126);
        }
        y += albumRows * 205 + 20;
      }
      if (artists.length) {
        ctx.textAlign = "right"; ctx.fillStyle = "#8b6f18"; ctx.font = "900 34px Arial"; ctx.fillText("הזמרים שבחרתי", width - 88, y); y += 40;
        const cellWidth = (width - 150) / 4;
        for (const [index, artist] of artists.entries()) {
          const column = index % 4, row = Math.floor(index / 4);
          const centerX = 75 + column * cellWidth + cellWidth / 2, imageY = y + row * 205;
          drawReceiptImage(ctx, loadedArtists[index], centerX - 68, imageY, 136, 136, 68, artist.name.slice(0, 1), true);
          ctx.textAlign = "center"; ctx.fillStyle = "#2b2340"; ctx.font = "800 21px Arial";
          ctx.fillText(receiptText(ctx, artist.name, cellWidth - 12), centerX, imageY + 170);
        }
      }
      ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "800 25px Arial"; ctx.fillText("גם אני השתתפתי במצעד הגדול של ראש בראש", width / 2, height - 52);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("יצירת הקובץ נכשלה.")), "image/png"));
      return new File([blob], "ההצבעה-שלי-ראש-בראש.png", { type: "image/png" });
    } finally { loaded.forEach((item) => item.cleanup()); }
}

function VoteReceipt({ albums, artists }: Receipt) {
  const { notify } = useNotice();
  const preparedFile = useRef<File | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [working, setWorking] = useState<"download" | "share" | null>(null);
  const receiptKey = JSON.stringify({ albums: albums.map((item) => [item.id, item.coverUrl, item.songs]), artists: artists.map((item) => [item.id, item.imageUrl]) });

  useEffect(() => {
    let active = true;
    preparedFile.current = null;
    queueMicrotask(() => { if (active) setPreparing(true); });
    void buildReceiptFile(albums, artists).then((file) => {
      if (active) preparedFile.current = file;
    }).catch((error) => {
      if (active) notify(error instanceof Error ? error.message : "יצירת כרטיס השיתוף נכשלה.", "error");
    }).finally(() => { if (active) setPreparing(false); });
    return () => { active = false; };
    // receiptKey changes only when the content or one of its images changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptKey, notify]);

  const getFile = async () => preparedFile.current || await buildReceiptFile(albums, artists);
  const saveFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url; link.download = file.name; link.style.display = "none";
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const download = async () => {
    setWorking("download");
    try { saveFile(await getFile()); notify("כרטיס ההצבעה הורד בהצלחה.", "success"); }
    catch (error) { notify(error instanceof Error ? error.message : "הורדת הכרטיס נכשלה.", "error"); }
    finally { setWorking(null); }
  };
  const share = async () => {
    setWorking("share");
    try {
      const file = await getFile();
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: "ההצבעה שלי בראש בראש", text: "אלה הבחירות שלי במצעד ראש בראש", files: [file] });
      } else {
        saveFile(file);
        notify("הדפדפן לא תומך בשיתוף קובץ ישיר, לכן כרטיס ההצבעה הורד ואפשר לצרף אותו להודעה.", "info");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(error instanceof Error ? error.message : "שיתוף ההצבעה נכשל.", "error");
    } finally { setWorking(null); }
  };
  const disabled = preparing || working !== null;
  return <section className="vote-receipt" aria-label="סיכום ההצבעה לשיתוף"><div className="receipt-heading"><small>הקול שלי במצעד</small><b>ראש בראש</b><span>25 שנות מוזיקה יהודית</span></div>{albums.length > 0 && <div className="receipt-section"><h2>האלבומים והשירים שבחרתי</h2><div className="receipt-album-grid">{albums.map((album, index) => <article key={album.id}><div className="receipt-cover">{album.coverUrl ? <img src={album.coverUrl} alt={`עטיפת ${album.title}`} loading="lazy" /> : <span>♫</span>}</div><div><small>בחירה {index + 1}</small><b>{album.title}</b><span>{album.artistName}</span><em>{album.songs.length ? album.songs.join(" · ") : "ללא בחירת שיר"}</em></div></article>)}</div></div>}{artists.length > 0 && <div className="receipt-section"><h2>הזמרים שבחרתי</h2><div className="receipt-artist-grid">{artists.map((artist) => <article key={artist.id}>{artist.imageUrl ? <img src={artist.imageUrl} alt={`תמונת ${artist.name}`} loading="lazy" /> : <span>{artist.name.slice(0, 1)}</span>}<b>{artist.name}</b></article>)}</div></div>}<footer><button type="button" disabled={disabled} onClick={() => void download()}>{preparing ? "מכין את הכרטיס…" : working === "download" ? "מוריד…" : "הורדת הכרטיס"}</button><button type="button" disabled={disabled} className="share-receipt" onClick={() => void share()}>{preparing ? "מכין את הכרטיס…" : working === "share" ? "פותח שיתוף…" : "שיתוף ההצבעה שלי"}</button></footer></section>;
}

function Title({ kicker, title, count }: { kicker: string; title: string; count?: string }) { return <div className="section-title"><div><p className="kicker">{kicker}</p><h2>{title}</h2></div>{count && <strong>{count}</strong>}</div>; }

function BrowsePanel({ catalog, loadSongMedia }: { catalog: Catalog; loadSongMedia(albumIds: string[]): Promise<void> }) {
  const { song: currentSong, play, setSiblings } = usePlayer();
  const [open, setOpen] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const songsByAlbum = useMemo(() => {
    const map = new Map<string, Song[]>();
    catalog.songs.forEach((song) => {
      const list = map.get(song.albumId) || [];
      list.push(song);
      map.set(song.albumId, list);
    });
    return map;
  }, [catalog.songs]);
  const selectedAlbum = catalog.albums.find((a) => a.id === selectedAlbumId);
  const selectedSongs = selectedAlbumId ? songsByAlbum.get(selectedAlbumId) || [] : [];
  useEffect(() => { if (selectedAlbumId) void loadSongMedia([selectedAlbumId]); }, [selectedAlbumId, loadSongMedia]);
  const closePanel = useCallback(() => {
    setOpen(false);
    setSelectedAlbumId(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closePanel(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, closePanel]);

  return <>
    <button ref={triggerRef} type="button" className="browse-fab" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-controls="songs-dialog" aria-label="שמיעת השירים המתמודדים">
      <span className="browse-fab-icon">♫</span>
      <span className="browse-fab-label">שמיעת השירים</span>
    </button>
    {open && <><div className="browse-backdrop" aria-hidden="true" onClick={closePanel} />
    <div ref={dialogRef} id="songs-dialog" className="browse-wrap open" role="dialog" aria-modal="true" aria-labelledby="songs-dialog-title">
      <aside className="browse-panel">
        <header className="browse-header">
          <h3 id="songs-dialog-title">השירים המתמודדים</h3>
          <button ref={closeRef} type="button" className="browse-close" aria-label="סגירת חלון השירים" onClick={closePanel}>✕</button>
        </header>
        <div className="browse-body">
          {catalog.albums.map((album) => {
            const albumSongs = songsByAlbum.get(album.id) || [];
            const isSelected = selectedAlbumId === album.id;
            return <button type="button" key={album.id} aria-expanded={isSelected} className={`browse-album-header ${isSelected ? "expanded" : ""}`} onClick={() => setSelectedAlbumId(isSelected ? null : album.id)}>
              {album.coverUrl ? <img className="browse-album-cover" src={album.coverUrl} alt="" /> : <span className="browse-album-cover browse-cover-fallback">♫</span>}
              <div className="browse-album-info"><b>{album.title}</b><small>{album.artistName} · {albumSongs.length} שירים</small></div>
              <span className="browse-album-arrow">{isSelected ? "◂" : "◂"}</span>
            </button>;
          })}
        </div>
      </aside>
      {selectedAlbumId && <aside className="browse-songs-panel">
        <header className="browse-header browse-songs-header">
          <button type="button" className="browse-back" aria-label="חזרה לרשימת האלבומים" onClick={() => setSelectedAlbumId(null)}>▸</button>
          <div className="browse-songs-title">
            {selectedAlbum?.coverUrl && <img className="browse-album-cover" src={selectedAlbum.coverUrl} alt="" />}
            <div><b>{selectedAlbum?.title}</b><small>{selectedAlbum?.artistName}</small></div>
          </div>
        </header>
        <div className="browse-body">
          {selectedSongs.map((song) => {
            const isPlaying = currentSong?.id === song.id;
            return <button type="button" key={song.id} aria-pressed={isPlaying} aria-label={`${isPlaying ? "עצירת" : "השמעת"} ${song.title}`} className={`browse-song ${isPlaying ? "playing" : ""}`} onClick={() => { setSiblings(selectedSongs.filter(s => s.audioUrl)); play(song); }}>
              {song.coverUrl && <img className="browse-song-cover" src={song.coverUrl} alt="" />}
              <span className="browse-song-title">{song.title}</span>
              <span className="browse-song-action">{isPlaying ? "■" : "▶"}</span>
            </button>;
          })}
          {selectedSongs.length === 0 && <p className="browse-empty">אין שירים באלבום זה</p>}
        </div>
      </aside>}
    </div></>}
  </>;
}
