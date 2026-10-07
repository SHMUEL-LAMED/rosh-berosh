"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { saveListenPosition } from "./listen-position";

/* episodeId: הקלטה של תוכנית מאתר התוכניות (לא קטע שיר) — previewStart הוא רק נקודת ההמשך,
   הסרגל מכסה את כל ההקלטה, והמיקום נשמר בחשבון כדי שבחזרה לאתר ימשיכו מאותו מקום. */
export type PlayerSong = { id: string; albumId: string; title: string; audioUrl?: string | null; coverUrl?: string | null; previewStart?: number; previewEnd?: number; episodeId?: string; duration?: number };

type PlayerContextType = {
  song: PlayerSong | null;
  play(song: PlayerSong): void;
  stop(): void;
  setSiblings(songs: PlayerSong[]): void;
};

const Ctx = createContext<PlayerContextType>({ song: null, play() {}, stop() {}, setSiblings() {} });

export function usePlayer() { return useContext(Ctx); }

function pauseAllAudio() {
  if (typeof document === "undefined") return;
  document.querySelectorAll("audio").forEach((element) => element.pause());
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [song, setSong] = useState<PlayerSong | null>(null);
  const [siblings, setSiblings] = useState<PlayerSong[]>([]);
  const play = useCallback((s: PlayerSong) => {
    pauseAllAudio();
    setSong((cur) => cur?.id === s.id ? null : s);
  }, []);
  const changeSong = useCallback((s: PlayerSong) => {
    pauseAllAudio();
    setSong(s);
  }, []);
  const stop = useCallback(() => {
    pauseAllAudio();
    setSong(null);
  }, []);
  return <Ctx.Provider value={{ song, play, stop, setSiblings }}>
    {children}
    {song && <AudioDock key={song.id} song={song} siblings={siblings} onClose={stop} onChangeSong={changeSong} />}
  </Ctx.Provider>;
}

function AudioDock({ song, siblings, onClose, onChangeSong }: { song: PlayerSong; siblings: PlayerSong[]; onClose(): void; onChangeSong(s: PlayerSong): void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const start = Math.max(0, song.previewStart ?? 0);
  const episode = song.episodeId || "";
  const rangeStart = episode ? 0 : start;   // בתוכנית הסרגל מתחיל מההתחלה, גם כשממשיכים מהאמצע
  const configuredEnd = episode ? 0 : Math.max(start, song.previewEnd ?? 0);
  const end = configuredEnd > start ? configuredEnd : duration || song.duration || 0;

  const idx = siblings.findIndex((s) => s.id === song.id);
  const onPrev = idx > 0 ? () => onChangeSong(siblings[idx - 1]) : undefined;
  const onNext = idx >= 0 && idx < siblings.length - 1 ? () => onChangeSong(siblings[idx + 1]) : undefined;

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    setCurrent(start); setPlaying(false);
    const begin = () => { setDuration(el.duration || 0); el.currentTime = start; setCurrent(start); el.play().then(() => setPlaying(true)).catch(() => undefined); };
    el.addEventListener("loadedmetadata", begin, { once: true });
    // הזרמה שנתקעה או נפלה באמצע: טוענים מחדש מאותה נקודה, פעם אחת לכל נפילה
    let stall = 0;
    let retried = false;
    const resume = () => {
      if (!song.audioUrl || el.paused && !el.error) return;
      const at = el.currentTime;
      el.src = song.audioUrl;
      el.load();
      el.addEventListener("loadedmetadata", () => { el.currentTime = at; el.play().catch(() => undefined); }, { once: true });
    };
    const watch = () => { window.clearTimeout(stall); stall = window.setTimeout(() => { if (!el.paused && el.readyState < 3) resume(); }, 8000); };
    const clear = () => { window.clearTimeout(stall); retried = false; };
    const failed = () => { if (!retried && el.currentTime > 0) { retried = true; resume(); } };
    el.addEventListener("waiting", watch);
    el.addEventListener("stalled", watch);
    el.addEventListener("playing", clear);
    el.addEventListener("pause", () => window.clearTimeout(stall));
    el.addEventListener("error", failed);
    // תוכנית: המיקום נשמר בחשבון — כל חצי דקה בזמן ניגון, ובעצירה, במעבר לרקע ובסגירת הדף
    const persist = (force = false, keepalive = false) => { if (episode && el.currentTime > 0) void saveListenPosition(episode, el.currentTime, el.duration, { force, keepalive }); };
    const onTime = () => persist();
    const onPause = () => persist(true);
    const onHide = () => { if (document.hidden) persist(true, true); };
    const onLeave = () => persist(true, true);
    if (episode) {
      el.addEventListener("timeupdate", onTime);
      el.addEventListener("pause", onPause);
      document.addEventListener("visibilitychange", onHide);
      window.addEventListener("pagehide", onLeave);
    }
    return () => {
      if (episode) {
        persist(true, true);
        el.removeEventListener("timeupdate", onTime);
        el.removeEventListener("pause", onPause);
        document.removeEventListener("visibilitychange", onHide);
        window.removeEventListener("pagehide", onLeave);
      }
      window.clearTimeout(stall);
      el.removeEventListener("waiting", watch);
      el.removeEventListener("stalled", watch);
      el.removeEventListener("playing", clear);
      el.removeEventListener("error", failed);
      el.removeEventListener("loadedmetadata", begin);
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [song, start, episode]);

  const toggle = () => { const el = audio.current; if (!el) return; if (el.paused) { if (end && el.currentTime >= end) el.currentTime = rangeStart; el.play().then(() => setPlaying(true)).catch(() => undefined); } else { el.pause(); setPlaying(false); } };
  const seek = (v: number) => { if (audio.current) { audio.current.currentTime = v; setCurrent(v); } };
  const changeVolume = (v: number) => { if (audio.current) audio.current.volume = v; setVolume(v); };
  const fmt = (v: number) => {
    if (!Number.isFinite(v) || v < 0) return "0:00";
    const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = String(Math.floor(v % 60)).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;   // תוכנית שלמה נמשכת יותר משעה
  };

  return <div className="audio-dock">
    <audio ref={audio} key={song.id} src={song.audioUrl ? (start > 0 ? `${song.audioUrl}#t=${start}` : song.audioUrl) : ""} preload="auto"
      onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
      onTimeUpdate={(e) => { const v = e.currentTarget.currentTime; setCurrent(v); if (configuredEnd > start && v >= configuredEnd) { e.currentTarget.pause(); e.currentTarget.currentTime = start; setCurrent(start); setPlaying(false); } }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    <button className="player-close" onClick={onClose} aria-label="סגירת הנגן">×</button>
    {song.coverUrl && <img className="player-cover" src={song.coverUrl} alt="" />}
    <div className="player-controls">
      <button className="player-skip" disabled={!onPrev} onClick={onPrev} aria-label="שיר קודם">⏮</button>
      <button className="player-main" onClick={toggle} aria-label={playing ? "השהיה" : "נגינה"}>{playing ? "❚❚" : "▶"}</button>
      <button className="player-skip" disabled={!onNext} onClick={onNext} aria-label="שיר הבא">⏭</button>
    </div>
    <div className="player-copy" aria-live="polite"><small>{episode ? "ממשיכים מאתר התוכניות" : configuredEnd > start ? "קטע נבחר" : "מתנגן עכשיו"}</small><b title={song.title}>{song.title || "קובץ שמע"}</b></div>
    <div className="player-progress">
      <input aria-label={episode ? "מיקום בהקלטה" : "מיקום בשיר"} type="range" min={rangeStart} max={Math.max(rangeStart + 1, end || duration || 1)} step="0.1" value={Math.min(current, Math.max(rangeStart + 1, end || duration || 1))} onChange={(e) => seek(Number(e.target.value))} />
      <span>{fmt(current - rangeStart)} / {fmt(Math.max(0, end - rangeStart))}</span>
    </div>
    <label className="player-volume" aria-label="עוצמת שמע">🔊<input type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => changeVolume(Number(e.target.value))} /></label>
  </div>;
}
