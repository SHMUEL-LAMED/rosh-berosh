"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, streamUrl, type Episode } from "./programs-core";

type Suggestion = { episodeId: string; title: string; start: number; end: number; text: string; part: number };
type Range = { start: number; end: number; text: string; selected: boolean };
const clock = (seconds: number) => {
  const n = Math.floor(Math.max(0, seconds));
  const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const parseClock = (value: string) => {
  const parts = value.trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
};

export function ProgramsAds({ episodes, patchEpisode, onMessage }: { episodes: Episode[]; patchEpisode(id: string, fields: Partial<Episode>): void; onMessage(message: string): void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const episode = episodes.find((item) => item.id === selectedId);
  const active = ranges[activeIndex];
  const count = ranges.filter((item) => item.selected).length;
  const counts = useMemo(() => suggestions.reduce<Record<string, number>>((map, item) => { map[item.episodeId] = (map[item.episodeId] || 0) + 1; return map; }, {}), [suggestions]);
  const programs = useMemo(() => episodes.filter((item) => streamUrl(item)).filter((item) => {
    const name = `${item.number || ""} ${item.title}`.toLocaleLowerCase("he");
    return (!search || name.includes(search.toLocaleLowerCase("he"))) && (showAll || search || counts[item.id]);
  }).sort((a, b) => (Number(!!counts[b.id]) - Number(!!counts[a.id])) || (b.number || 0) - (a.number || 0)), [episodes, counts, search, showAll]);
  const scan = async () => {
    setLoading(true); setError("");
    try { setSuggestions((await api<{ suggestions: Suggestion[] }>("/api/program/ai/ad-candidates")).suggestions || []); }
    catch (cause) { setError(errorText(cause, "סריקת התמלולים נכשלה.")); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let alive = true;
    api<{ suggestions: Suggestion[] }>("/api/program/ai/ad-candidates")
      .then((result) => { if (alive) setSuggestions(result.suggestions || []); })
      .catch((cause) => { if (alive) setError(errorText(cause, "סריקת התמלולים נכשלה.")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const choose = (id: string) => {
    setSelectedId(id); setActiveIndex(0); setError(""); setReady(false);
    setRanges(suggestions.filter((item) => item.episodeId === id).map((item) => ({ start: item.start, end: item.end, text: item.text, selected: false })));
  };
  const change = (index: number, fields: Partial<Range>) => setRanges((current) => current.map((item, i) => i === index ? { ...item, ...fields } : item));
  const transcribe = async () => {
    if (!episode || transcribing) return;
    const id = episode.id;
    setError(""); setTranscribing("טוענים תמלול…");
    try {
      const state = await api<{ partsDone: number; partsTotal: number }>(`/api/program/ai/transcript/${encodeURIComponent(id)}`);
      let part = state.partsDone || 0, total = state.partsTotal || 1;
      while (part < total) {
        setTranscribing(`סורקים את ההקלטה: ${part + 1} מתוך ${total}`);
        const result = await api<{ partsTotal: number }>("/api/program/ai/transcribe", { method: "POST", body: JSON.stringify({ episodeId: id, part }) });
        total = result.partsTotal || total; part++;
      }
      const found = (await api<{ suggestions: Suggestion[] }>("/api/program/ai/ad-candidates")).suggestions || [];
      setSuggestions(found); setActiveIndex(0);
      setRanges(found.filter((item) => item.episodeId === id).map((item) => ({ start: item.start, end: item.end, text: item.text, selected: false })));
      onMessage("הסריקה הושלמה. אפשר להאזין לקטעים שסומנו.");
    } catch (cause) { setError(errorText(cause, "הסריקה נעצרה. לחיצה נוספת תמשיך מאותו חלק.")); }
    finally { setTranscribing(""); }
  };
  const cut = async () => {
    if (!episode || !audio.current || !Number.isFinite(audio.current.duration)) { setError("המתינו לטעינת ההקלטה בנגן."); return; }
    const cuts = ranges.filter((item) => item.selected).map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
    const duration = audio.current.duration;
    if (!cuts.length || cuts.some((item, i) => !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end > duration + 2 || item.end - item.start < .2 || (i > 0 && item.start < cuts[i - 1].end))) {
      setError("תקנו את זמני החיתוך: ההתחלה צריכה להיות לפני הסוף, בלי חפיפה בין קטעים."); return;
    }
    if (!confirm(`לחתוך ${cuts.length} קטעים מהתוכנית ״${episode.title}״? המקור יישמר, וההקלטה החדשה תמתין לפרסום.`)) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ url: string; key: string; duration: number }>("/api/program/audio/cut", { method: "POST", body: JSON.stringify({ episodeId: episode.id, sourceKey: episode.r2Key, duration, cuts }) });
      patchEpisode(episode.id, { audio: result.url, r2Key: result.key, audioSource: "r2", duration: Math.round(result.duration) });
      setReady(true); setRanges([]); setSuggestions((current) => current.filter((item) => item.episodeId !== episode.id));
      onMessage("ההקלטה הנקייה מוכנה. פרסמו אותה כדי שהמאזינים ישמעו אותה.");
    } catch (cause) { setError(errorText(cause, "החיתוך נכשל. המקור נשאר ללא שינוי.")); }
    finally { setBusy(false); }
  };
  const seek = (at: number) => { if (audio.current) { audio.current.currentTime = Math.max(0, at); void audio.current.play(); } };
  const mark = (field: "start" | "end") => {
    if (!audio.current || !active) return;
    change(activeIndex, { [field]: Math.round(audio.current.currentTime * 10) / 10 });
  };
  const editTime = (field: "start" | "end", value: string) => {
    const seconds = parseClock(value);
    if (seconds === null) { setError("כתבו זמן בצורה 01:23 או 1:02:03."); return; }
    setError(""); change(activeIndex, { [field]: seconds });
  };

  return <section className="admin-panel prog-ad-page" data-tour="ads" dir="rtl">
    <header className="prog-ad-heading"><div><p className="prog-ad-kicker">עריכת הקלטות</p><h2>הסרת פרסומות מתוכניות</h2><p>בוחרים תוכנית, מאזינים ומאשרים את הקטעים שרוצים להסיר.</p></div><button type="button" className="prog-ad-refresh" onClick={() => void scan()} disabled={loading}>{loading ? "מחפש קטעים…" : "רענון הצעות"}</button></header>
    {error && <p role="alert" className="prog-error">{error}</p>}
    <div className="prog-ad-layout">
      <aside className="prog-ad-programs" data-tour="ads-pick" aria-label="בחירת תוכנית"><h3>תוכניות לבדיקה</h3>
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="חיפוש לפי שם או מספר" aria-label="חיפוש תוכנית" />
        <div className="prog-ad-program-list">{programs.slice(0, search || showAll ? undefined : 12).map((item) => <button type="button" key={item.id} className={item.id === selectedId ? "active" : ""} aria-current={item.id === selectedId ? "true" : undefined} onClick={() => choose(item.id)}>
          <span><b>{item.number ? `תוכנית ${item.number}` : item.title}</b><small>{item.number ? item.title : ""}</small></span><em>{counts[item.id] ? `${counts[item.id]} חשודים` : "בדיקה ידנית"}</em></button>)}</div>
        {!programs.length && <p className="prog-hint">{loading ? "מחפשים בתמלולים…" : "אין כאן תוכניות עם הצעות. אפשר לחפש תוכנית או להציג את כולן."}</p>}
        {!search && <button type="button" className="prog-ad-showall" onClick={() => setShowAll((current) => !current)}>{showAll ? "רק תוכניות עם הצעות" : "הצגת כל התוכניות"}</button>}
      </aside>
      <div className="prog-ad-workspace">{!episode ? <div className="prog-ad-empty"><strong>בחרו תוכנית מהרשימה</strong><p>ההקלטה והקטעים החשודים יופיעו כאן.</p></div> : <>
        <div className="prog-ad-title"><div><small>עובדים עכשיו על</small><h3>{episode.number ? `תוכנית ${episode.number} · ` : ""}{episode.title}</h3></div><span>{ranges.length ? `${ranges.length} הצעות לבדיקה` : "בלי הצעות"}</span></div>
        <div className="prog-ad-player"><audio key={episode.audio} ref={audio} controls preload="metadata" src={streamUrl(episode)} aria-label={`הקלטה של ${episode.title}`} /></div>
        {ready ? <div className="prog-ad-done" role="status"><strong>✓ ההקלטה הנקייה מוכנה</strong><p>האזינו לגרסה החדשה בנגן. כדי שתופיע באתר למאזינים, פרסמו אותה.</p><a className="prog-ad-primary" href="#prog-publish">מעבר לפרסום התוכנית ←</a></div> : <>
          {!ranges.length && <div className="prog-ad-empty"><strong>לא נמצאו קטעים חשודים בתוכנית הזו</strong><p>אפשר לסרוק את ההקלטה או לסמן פרסומת בעצמכם בזמן ההאזנה.</p></div>}
          <div className="prog-ad-tools"><button type="button" onClick={() => void transcribe()} disabled={!!transcribing || busy}>{transcribing || "סריקה אוטומטית של התוכנית"}</button><button type="button" onClick={() => { const at = Math.floor(audio.current?.currentTime || 0); setActiveIndex(ranges.length); setRanges((current) => [...current, { start: at, end: at + 15, text: "קטע שסומן ידנית", selected: false }]); }}>+ סימון קטע בעצמי</button></div>
          {!!ranges.length && <><h4 className="prog-ad-subtitle">קטעים לבדיקה <small>לחצו על קטע כדי להאזין לו</small></h4>
            <div className="prog-ad-cues">{ranges.map((item, index) => <button type="button" key={index} className={`${index === activeIndex ? "active" : ""} ${item.selected ? "marked" : ""}`} onClick={() => { setActiveIndex(index); seek(item.start - 5); }} aria-pressed={index === activeIndex}>
              <span>קטע {index + 1} <small>סביב {clock(item.start)}</small></span><b>{item.selected ? "✓ לסילוק" : "▶ בדיקה"}</b></button>)}</div>
            {active && <div className="prog-ad-editor" key={`${selectedId}-${activeIndex}`}><div className="prog-ad-editor-title"><b>קטע {activeIndex + 1}</b><button type="button" onClick={() => seek(active.start - 5)}>▶ האזנה מההתחלה</button></div>
              <p className="prog-ad-editor-help">הזמנים שהמערכת הציעה משוערים. השמיעו את הקטע וסמנו בדיוק איפה הפרסומת מתחילה ונגמרת.</p>
              <div className="prog-ad-boundaries"><div><span>תחילת הפרסומת</span><strong>{clock(active.start)}</strong><button type="button" onClick={() => mark("start")}>סמן התחלה במקום הנוכחי</button><label>תיקון ידני <input key={`start-${active.start}`} type="text" dir="ltr" defaultValue={clock(active.start)} onBlur={(event) => editTime("start", event.target.value)} aria-label="זמן התחלת הפרסומת" /></label></div>
                <div><span>סוף הפרסומת</span><strong>{clock(active.end)}</strong><button type="button" onClick={() => mark("end")}>סמן סוף במקום הנוכחי</button><label>תיקון ידני <input key={`end-${active.end}`} type="text" dir="ltr" defaultValue={clock(active.end)} onBlur={(event) => editTime("end", event.target.value)} aria-label="זמן סיום הפרסומת" /></label></div></div>
              <div className="prog-ad-editor-bottom"><button type="button" className={active.selected ? "marked" : "prog-ad-primary"} aria-pressed={active.selected} onClick={() => change(activeIndex, { selected: !active.selected })}>{active.selected ? "✓ מסומן לחיתוך · ביטול סימון" : "אישור: להסיר את הקטע הזה"}</button><button type="button" className="prog-ad-remove" onClick={() => { setRanges((current) => current.filter((_, i) => i !== activeIndex)); setActiveIndex(0); }}>זה לא פרסומת</button></div>
              {active.text && active.text !== "קטע שסומן ידנית" && <details><summary>למה הקטע סומן?</summary><p>{active.text}</p></details>}
            </div>}
          </>}
          {count > 0 && <div className="prog-ad-submit"><span><strong>{count} קטעים אושרו להסרה</strong><small>הקובץ המקורי נשמר, ורק אחרי פרסום המאזינים ישמעו את החדש.</small></span><button type="button" disabled={busy} onClick={() => void cut()}>{busy ? "מכינים הקלטה נקייה…" : "יצירת הקלטה נקייה ←"}</button></div>}
        </>}
      </>}</div>
    </div>
  </section>;
}
