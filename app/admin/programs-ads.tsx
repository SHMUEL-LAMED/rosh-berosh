"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, fmtDuration, streamUrl, type Episode } from "./programs-core";

type Suggestion = { episodeId: string; title: string; start: number; end: number; text: string; part: number };
type Range = { start: number; end: number; text: string; selected: boolean };

export function ProgramsAds({ episodes, patchEpisode, onMessage }: { episodes: Episode[]; patchEpisode(id: string, fields: Partial<Episode>): void; onMessage(message: string): void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const episode = episodes.find((item) => item.id === selectedId);
  const counts = useMemo(() => suggestions.reduce<Record<string, number>>((map, item) => { map[item.episodeId] = (map[item.episodeId] || 0) + 1; return map; }, {}), [suggestions]);
  const scan = async () => {
    setLoading(true); setError("");
    try { setSuggestions((await api<{ suggestions: Suggestion[] }>("/api/program/ai/ad-candidates")).suggestions || []); }
    catch (cause) { setError(errorText(cause, "סריקת התמלולים נכשלה.")); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let active = true;
    api<{ suggestions: Suggestion[] }>("/api/program/ai/ad-candidates")
      .then((result) => { if (active) setSuggestions(result.suggestions || []); })
      .catch((cause) => { if (active) setError(errorText(cause, "סריקת התמלולים נכשלה.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const choose = (id: string) => {
    setSelectedId(id);
    setRanges(suggestions.filter((item) => item.episodeId === id).map((item) => ({ start: item.start, end: item.end, text: item.text, selected: false })));
  };
  const change = (index: number, fields: Partial<Range>) => setRanges((current) => current.map((item, i) => i === index ? { ...item, ...fields } : item));
  const transcribe = async () => {
    if (!episode || transcribing) return;
    const id = episode.id;
    setError(""); setTranscribing("טוענים את מצב התמלול…");
    try {
      const state = await api<{ partsDone: number; partsTotal: number }>(`/api/program/ai/transcript/${encodeURIComponent(id)}`);
      let part = state.partsDone || 0, total = state.partsTotal || 1;
      while (part < total) {
        setTranscribing(`מתמללים את תוכנית ${episode.number || episode.title}: חלק ${part + 1} מתוך ${total}`);
        const result = await api<{ partsTotal: number }>("/api/program/ai/transcribe", { method: "POST", body: JSON.stringify({ episodeId: id, part }) });
        total = result.partsTotal || total; part++;
      }
      const found = (await api<{ suggestions: Suggestion[] }>("/api/program/ai/ad-candidates")).suggestions || [];
      setSuggestions(found);
      setRanges(found.filter((item) => item.episodeId === id).map((item) => ({ start: item.start, end: item.end, text: item.text, selected: false })));
      onMessage("התמלול הושלם והקטעים החשודים סומנו לבדיקה.");
    } catch (cause) { setError(errorText(cause, "התמלול נעצר. אפשר ללחוץ שוב כדי להמשיך מאותו חלק.")); }
    finally { setTranscribing(""); }
  };
  const cut = async () => {
    if (!episode || !audio.current || !Number.isFinite(audio.current.duration)) { setError("חכו עד שאורך ההקלטה ייטען בנגן."); return; }
    const cuts = ranges.filter((r) => r.selected).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
    const duration = audio.current.duration;
    if (!cuts.length || cuts.some((r, i) => !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end > duration + 2 || r.end - r.start < .2 || (i > 0 && r.start < cuts[i - 1].end))) { setError("בדקו את גבולות החיתוך: בלי חפיפה, ובתחומי ההקלטה."); return; }
    if (!confirm(`לחתוך ${cuts.length} קטעים מהתוכנית ״${episode.title}״? המקור יישמר, והתוצאה תיכנס לטיוטה עד לפרסום.`)) return;
    setBusy(true); setError("");
    try {
      const sourceKey = typeof episode.r2Key === "string" ? episode.r2Key : "";
      const result = await api<{ url: string; key: string; duration: number }>("/api/program/audio/cut", { method: "POST", body: JSON.stringify({ episodeId: episode.id, sourceKey, duration, cuts }) });
      patchEpisode(episode.id, { audio: result.url, r2Key: result.key, audioSource: "r2", duration: Math.round(result.duration) });
      setRanges([]); setSuggestions((current) => current.filter((item) => item.episodeId !== episode.id));
      onMessage("ההקלטה הנקייה מוכנה בטיוטה. לחצו ״פרסום התוכניות״ כדי שהמאזינים יקבלו אותה.");
    } catch (cause) { setError(errorText(cause, "החיתוך נכשל. המקור נשאר ללא שינוי.")); }
    finally { setBusy(false); }
  };
  return <section className="admin-panel" data-tour="ads"><h2>ניקוי פרסומות מהתוכניות</h2>
    <p className="panel-help">הסריקה מסמנת משפטים שנשמעים כמו פרסומת. הזמנים מהתמלול הישן משוערים: האזינו לכל הצעה, כוונו את הגבולות וסמנו לחיתוך. אפשר להוסיף קטע ידנית. ההקלטה המקורית נשמרת.</p>
    <button type="button" className="prog-btn" onClick={() => void scan()} disabled={loading}>{loading ? "מחפשים בתמלולים…" : `סריקה חוזרת · ${suggestions.length} חשודים`}</button>
    {error && <p role="alert" className="prog-error">{error}</p>}
    <label className="prog-field" data-tour="ads-pick">תוכנית <select value={selectedId} onChange={(event) => choose(event.target.value)}><option value="">בחרו תוכנית לבדיקה</option>{episodes.filter((item) => streamUrl(item)).sort((a, b) => (b.number || 0) - (a.number || 0)).map((item) => <option value={item.id} key={item.id}>{item.number ? `תוכנית ${item.number} · ` : ""}{item.title} · {counts[item.id] || 0} חשודים</option>)}</select></label>
    {episode && <><audio key={episode.audio} ref={audio} controls preload="metadata" src={streamUrl(episode)} style={{ width: "100%", marginBlock: 16 }} />
      <div><button type="button" className="prog-btn" disabled={!!transcribing} onClick={() => void transcribe()}>{transcribing || "תמלול ובדיקת פרסומות בתוכנית הזו"}</button></div>
      <p className="panel-help">לחצו ״האזנה״ ליד קטע כדי לקפוץ אליו. ״עכשיו״ מעתיק את מיקום הנגן לשדה הזמן. הזמנים בשניות.</p>
      <button type="button" className="prog-btn" onClick={() => { const at = Math.floor(audio.current?.currentTime || 0); setRanges((current) => [...current, { start: at, end: at + 15, text: "קטע שסומן ידנית", selected: false }]); }}>+ הוספת קטע ידנית</button>
      {ranges.map((range, i) => <div className="prog-ad-range" key={i}>
        <label><input type="checkbox" checked={range.selected} onChange={(event) => change(i, { selected: event.target.checked })} /> להסיר את הקטע</label><p>{range.text}</p>
        <div className="prog-ad-actions"><button type="button" onClick={() => { if (audio.current) { audio.current.currentTime = Math.max(0, range.start - 5); void audio.current.play(); } }}>▶ האזנה</button>
          <label>התחלה <input type="number" min="0" step="0.1" value={range.start} onChange={(event) => change(i, { start: Number(event.target.value) })} /></label>
          <button type="button" onClick={() => change(i, { start: Math.round((audio.current?.currentTime || 0) * 10) / 10 })}>התחלה עכשיו</button>
          <label>סוף <input type="number" min="0" step="0.1" value={range.end} onChange={(event) => change(i, { end: Number(event.target.value) })} /></label>
          <button type="button" onClick={() => change(i, { end: Math.round((audio.current?.currentTime || 0) * 10) / 10 })}>סוף עכשיו</button>
          <button type="button" onClick={() => setRanges((current) => current.filter((_, index) => index !== i))}>הסרה מהרשימה</button></div>
        <small>{fmtDuration(range.start)}–{fmtDuration(range.end)}</small>
      </div>)}
      <button type="button" className="prog-btn" disabled={busy || !ranges.some((r) => r.selected)} onClick={() => void cut()}>{busy ? "חותכים ושומרים קובץ חדש…" : "אישור חיתוך הקטעים המסומנים"}</button>
      <p className="panel-help">אחרי החיתוך עברו ללשונית ״פרסום התוכניות״. אל תסגרו את הדף בזמן הכנת הקובץ.</p>
    </>}
  </section>;
}
