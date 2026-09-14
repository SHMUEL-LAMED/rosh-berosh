"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Album = { id: string; title: string; artistName: string; active: number };
type Song = { id: string; albumId: string; title: string; active: number };
type Artist = { id: string; name: string; active: number };
type Settings = { albumsEnabled: number; albumsMin: number; albumsMax: number; songsEnabled: number; songsMin: number; songsMax: number; artistsEnabled: number; artistsMin: number; artistsMax: number };
type Prompt = { key: string; audioUrl: string };
type Props = { surveyId?: string; albums: Album[]; songs: Song[]; artists: Artist[]; settings: Settings; prompts: Prompt[] };
type Phase = "idle" | "albums" | "songs" | "artists" | "done";

const widthFor = (count: number) => Math.max(1, String(Math.max(1, count)).length);
const codeFor = (index: number, width: number) => String(index + 1).padStart(width, "0");

export function PhonePreview({ surveyId, albums, songs, artists, settings, prompts }: Props) {
  const activeAlbums = useMemo(() => albums.filter((item) => item.active), [albums]);
  const activeArtists = useMemo(() => artists.filter((item) => item.active), [artists]);
  const promptMap = useMemo(() => new Map(prompts.filter((item) => item.audioUrl).map((item) => [item.key, item.audioUrl])), [prompts]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [buffer, setBuffer] = useState("");
  const [status, setStatus] = useState("מוכן לשיחת בדיקה");
  const [albumIds, setAlbumIds] = useState<string[]>([]);
  const [songIds, setSongIds] = useState<Record<string, string[]>>({});
  const [artistIds, setArtistIds] = useState<string[]>([]);
  const [songAlbumIndex, setSongAlbumIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = useCallback(() => {
    audioRef.current?.pause(); audioRef.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, []);
  useEffect(() => stopAudio, [stopAudio]);

  const speakText = useCallback((message: string) => {
    stopAudio(); setStatus(message);
    if (typeof speechSynthesis === "undefined") return;
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "he-IL"; utterance.rate = .92;
    speechSynthesis.speak(utterance);
  }, [stopAudio]);
  const playPrompt = useCallback((key: string, fallback: string) => {
    stopAudio(); setStatus(fallback);
    const url = promptMap.get(key);
    if (!url) return speakText(fallback);
    const audio = new Audio(url); audioRef.current = audio;
    audio.onerror = () => speakText(fallback);
    void audio.play().catch(() => speakText(fallback));
  }, [promptMap, speakText, stopAudio]);

  const songsForAlbum = useCallback((albumId: string) => songs.filter((song) => song.active && song.albumId === albumId), [songs]);
  const firstPhase = useCallback((): Phase => settings.albumsEnabled ? "albums" : settings.artistsEnabled ? "artists" : "done", [settings]);

  const announce = useCallback((next: Phase, albumIndex = songAlbumIndex) => {
    setBuffer(""); setPhase(next);
    if (next === "albums") {
      const width = widthFor(activeAlbums.length);
      const list = activeAlbums.map((item, index) => `${item.title}, הקישו ${codeFor(index, width).split("").join(" ")}`).join(". ");
      return playPrompt(`albums-menu:${surveyId}`, `בחרו בין ${Math.min(settings.albumsMin, activeAlbums.length)} ל ${Math.min(settings.albumsMax, activeAlbums.length)} אלבומים. ${list}`);
    }
    if (next === "songs") {
      const album = activeAlbums.find((item) => item.id === albumIds[albumIndex]);
      if (!album) {
        if (settings.artistsEnabled) {
          setPhase("artists");
          const width = widthFor(activeArtists.length);
          const list = activeArtists.map((item, index) => `${item.name}, הקישו ${codeFor(index, width).split("").join(" ")}`).join(". ");
          return playPrompt(`artists-menu:${surveyId}`, `בחרו בין ${Math.min(settings.artistsMin, activeArtists.length)} ל ${Math.min(settings.artistsMax, activeArtists.length)} זמרים. ${list}`);
        }
        setPhase("done"); return speakText("תודה. תצוגת השיחה הסתיימה בהצלחה. ההצבעה לא נשמרה");
      }
      const listItems = songsForAlbum(album.id), width = widthFor(listItems.length);
      const list = listItems.map((item, index) => `${item.title}, הקישו ${codeFor(index, width).split("").join(" ")}`).join(". ");
      return playPrompt(`songs-menu:${album.id}`, `בחרו בין ${Math.min(settings.songsMin, listItems.length)} ל ${Math.min(settings.songsMax, listItems.length)} שירים מתוך האלבום ${album.title}. ${list}`);
    }
    if (next === "artists") {
      const width = widthFor(activeArtists.length);
      const list = activeArtists.map((item, index) => `${item.name}, הקישו ${codeFor(index, width).split("").join(" ")}`).join(". ");
      return playPrompt(`artists-menu:${surveyId}`, `בחרו בין ${Math.min(settings.artistsMin, activeArtists.length)} ל ${Math.min(settings.artistsMax, activeArtists.length)} זמרים. ${list}`);
    }
    if (next === "done") speakText("תודה. תצוגת השיחה הסתיימה בהצלחה. ההצבעה לא נשמרה");
  }, [activeAlbums, activeArtists, albumIds, playPrompt, settings, songAlbumIndex, songsForAlbum, speakText, surveyId]);

  const start = () => {
    setAlbumIds([]); setSongIds({}); setArtistIds([]); setSongAlbumIndex(0); setBuffer("");
    const next = firstPhase();
    speakText("ברוכים הבאים לתצוגה המקדימה של קו ההצבעה. ההצבעה לא תישמר");
    window.setTimeout(() => announce(next, 0), 1800);
  };
  const hangup = () => { stopAudio(); setPhase("idle"); setBuffer(""); setStatus("השיחה נותקה"); };

  const choose = useCallback((raw: string) => {
    if (phase === "albums") {
      const width = widthFor(activeAlbums.length);
      if (raw === "0".repeat(width) && albumIds.length >= Math.min(settings.albumsMin, activeAlbums.length)) {
        return announce(settings.songsEnabled && albumIds.length ? "songs" : settings.artistsEnabled ? "artists" : "done", 0);
      }
      const item = activeAlbums[Number(raw) - 1];
      if (!item || albumIds.includes(item.id)) return speakText("הבחירה לא נקלטה. נא לבחור אפשרות אחרת");
      const next = [...albumIds, item.id]; setAlbumIds(next); speakText(`בחרתם ${item.title}`);
      if (next.length >= Math.min(settings.albumsMax, activeAlbums.length)) window.setTimeout(() => announce(settings.songsEnabled ? "songs" : settings.artistsEnabled ? "artists" : "done", 0), 900);
      return;
    }
    if (phase === "songs") {
      const album = activeAlbums.find((item) => item.id === albumIds[songAlbumIndex]); if (!album) return;
      const list = songsForAlbum(album.id), width = widthFor(list.length), selected = songIds[album.id] || [];
      const advance = () => {
        if (songAlbumIndex < albumIds.length - 1) { const nextIndex = songAlbumIndex + 1; setSongAlbumIndex(nextIndex); announce("songs", nextIndex); }
        else announce(settings.artistsEnabled ? "artists" : "done", 0);
      };
      if (raw === "0".repeat(width) && selected.length >= Math.min(settings.songsMin, list.length)) return advance();
      const item = list[Number(raw) - 1];
      if (!item || selected.includes(item.id)) return speakText("הבחירה לא נקלטה. נא לבחור אפשרות אחרת");
      const next = [...selected, item.id]; setSongIds({ ...songIds, [album.id]: next }); speakText(`בחרתם ${item.title}`);
      if (next.length >= Math.min(settings.songsMax, list.length)) window.setTimeout(advance, 900);
      return;
    }
    if (phase === "artists") {
      const width = widthFor(activeArtists.length);
      if (raw === "0".repeat(width) && artistIds.length >= Math.min(settings.artistsMin, activeArtists.length)) return announce("done", 0);
      const item = activeArtists[Number(raw) - 1];
      if (!item || artistIds.includes(item.id)) return speakText("הבחירה לא נקלטה. נא לבחור אפשרות אחרת");
      const next = [...artistIds, item.id]; setArtistIds(next); speakText(`בחרתם ${item.name}`);
      if (next.length >= Math.min(settings.artistsMax, activeArtists.length)) window.setTimeout(() => announce("done", 0), 900);
    }
  }, [activeAlbums, activeArtists, albumIds, announce, artistIds, phase, settings, songAlbumIndex, songIds, songsForAlbum, speakText]);

  const press = (key: string) => {
    if (phase === "idle" || phase === "done") return;
    if (key === "*") return setBuffer("");
    const total = phase === "albums" ? activeAlbums.length : phase === "artists" ? activeArtists.length : songsForAlbum(albumIds[songAlbumIndex] || "").length;
    const width = widthFor(total), next = key === "#" ? buffer : `${buffer}${key}`.slice(-width);
    setBuffer(next); if (key === "#" || next.length >= width) { setBuffer(""); if (next) choose(next); }
  };

  return <div className="phone-emulator" dir="rtl">
    <div className="phone-speaker" />
    <div className="phone-screen"><small>{phase === "idle" ? "לא מחובר" : phase === "done" ? "השיחה הסתיימה" : "שיחת בדיקה פעילה"}</small><b>{status}</b><span>{buffer || " "}</span></div>
    <div className="phone-keypad">{"123456789*0#".split("").map((key) => <button type="button" key={key} disabled={phase === "idle" || phase === "done"} onClick={() => press(key)}>{key}</button>)}</div>
    {phase === "idle" || phase === "done" ? <button type="button" className="phone-call" onClick={start}>☎ התחלת שיחת בדיקה</button> : <button type="button" className="phone-hangup" onClick={hangup}>ניתוק</button>}
    <p>השמע וההקשות עוברים ברצף כמו בשיחה. בסיום לא נשמרת הצבעה.</p>
  </div>;
}
