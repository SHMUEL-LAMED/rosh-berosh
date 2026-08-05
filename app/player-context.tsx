"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type PlayerSong = { id: string; albumId: string; title: string; audioUrl?: string | null; coverUrl?: string | null; previewStart?: number; previewEnd?: number };

type PlayerContextType = {
  song: PlayerSong | null;
  play(song: PlayerSong): void;
  stop(): void;
  setSiblings(songs: PlayerSong[]): void;
};

const Ctx = createContext<PlayerContextType>({ song: null, play() {}, stop() {}, setSiblings() {} });

export function usePlayer() { return useContext(Ctx); }

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [song, setSong] = useState<PlayerSong | null>(null);
  const [siblings, setSiblings] = useState<PlayerSong[]>([]);
  const play = useCallback((s: PlayerSong) => setSong((cur) => cur?.id === s.id ? null : s), []);
  const stop = useCallback(() => setSong(null), []);
  return <Ctx.Provider value={{ song, play, stop, setSiblings }}>
    {children}
    {song && <AudioDock song={song} siblings={siblings} onClose={stop} onChangeSong={setSong} />}
  </Ctx.Provider>;
}

function AudioDock({ song, siblings, onClose, onChangeSong }: { song: PlayerSong; siblings: PlayerSong[]; onClose(): void; onChangeSong(s: PlayerSong): void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const start = Math.max(0, song.previewStart ?? 0);
  const configuredEnd = Math.max(start, song.previewEnd ?? 0);
  const end = configuredEnd > start ? configuredEnd : duration;

  const idx = siblings.findIndex((s) => s.id === song.id);
  const onPrev = idx > 0 ? () => onChangeSong(siblings[idx - 1]) : undefined;
  const onNext = idx >= 0 && idx < siblings.length - 1 ? () => onChangeSong(siblings[idx + 1]) : undefined;

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    setCurrent(start); setPlaying(false);
    const begin = () => { setDuration(el.duration || 0); el.currentTime = start; setCurrent(start); el.play().then(() => setPlaying(true)).catch(() => undefined); };
    el.addEventListener("loadedmetadata", begin, { once: true });
    return () => { el.pause(); };
  }, [song, start]);

  const toggle = () => { const el = audio.current; if (!el) return; if (el.paused) { if (el.currentTime >= end) el.currentTime = start; el.play().then(() => setPlaying(true)).catch(() => undefined); } else { el.pause(); setPlaying(false); } };
  const seek = (v: number) => { if (audio.current) { audio.current.currentTime = v; setCurrent(v); } };
  const changeVolume = (v: number) => { if (audio.current) audio.current.volume = v; setVolume(v); };
  const fmt = (v: number) => { if (!Number.isFinite(v) || v < 0) return "0:00"; return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`; };

  return <div className="audio-dock">
    <audio ref={audio} key={song.id} src={song.audioUrl ?? ""} preload="metadata"
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
    <div className="player-copy"><small>{configuredEnd > start ? "קטע נבחר" : "השיר המלא"}</small><b>{song.title}</b></div>
    <div className="player-progress">
      <input aria-label="מיקום בשיר" type="range" min={start} max={Math.max(start + 1, end || duration || 1)} step="0.1" value={Math.min(current, Math.max(start + 1, end || duration || 1))} onChange={(e) => seek(Number(e.target.value))} />
      <span>{fmt(current - start)} / {fmt(Math.max(0, end - start))}</span>
    </div>
    <label className="player-volume" aria-label="עוצמת שמע">🔊<input type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => changeVolume(Number(e.target.value))} /></label>
  </div>;
}
