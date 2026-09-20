"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analytics, RankedItem } from "./analytics-types";
import { downloadTablesXlsx, type TableSheet } from "./xlsx-export";
import {
  ActivityHeatmap, ChannelSplit, ChartLegend, CHANNEL_COLOR, CHANNEL_LABEL, CumulativeChart,
  DailyColumns, HeatLegend, RaceChart, RankBars, dayLabel,
} from "./analytics-charts";
import "./analytics-panel.css";

/**
 * לשונית "נתונים מתקדמים": ניתוחים שנוספים לצד "תוצאות" ו"מצביעים" ואינם
 * משנים אותם. הכול מגיע בבקשה אחת מ-/api/admin/analytics, ומוצג דרך
 * תפריט פנימי: נושא אחד על המסך בכל רגע, בלי עמוד אחד ארוך לגלול בו.
 *
 * "אחוזים בלבד" נועד לצילום מסך: אסור ששום מספר מוחלט ידלוף בו. לכן אין
 * כאן קריאות ישירות ל-toLocaleString על ספירות — כל ספירה עוברת דרך
 * הפורמטר שמקבל את המצב, וכך אי אפשר לשכוח מקום אחד.
 */

type Section = "pace" | "when" | "race" | "albums" | "cross" | "gaps" | "combos" | "timing" | "people" | "ops";
type Kind = "albums" | "songs" | "artists";

/**
 * תפריט פנימי במקום עמוד אחד ארוך: כל נושא הוא מסך בפני עצמו, ומה שלא
 * נבחר אינו מרונדר כלל — גם כדי שלא צריך לגלול, וגם כדי שטבלאות ארוכות
 * וגרפים לא יעבדו ברקע.
 */
const SECTIONS: Array<{ key: Section; label: string; help: string }> = [
  { key: "pace", label: "סקירה וקצב", help: "כמה נכנס עכשיו לעומת התקופה הקודמת באותו אורך, והקו המצטבר מתחילת הסקר." },
  { key: "when", label: "מתי מצביעים", help: "פעילות לפי יום בשבוע ושעה, בשעון ישראל. שימושי לתזמון פרסום ותזכורות." },
  { key: "race", label: "מרוץ הדירוג", help: "הקולות המצטברים של חמשת המובילים בכל יום — מי הוביל מתי, והאם המקום הראשון החליף ידיים." },
  { key: "albums", label: "אלבומים ושירים", help: "השיר המוביל בכל אלבום, פיזור הקולות בתוכו, ומי לא קיבל אף קול." },
  { key: "cross", label: "הצלבות", help: "מה הולך עם מה: האלבומים של מי שהצביעו לזמר, אלבומים שנבחרים יחד, וצמדי זמרים." },
  { key: "gaps", label: "פערים וריכוזיות", help: "לכל פריט: הקולות מכל ערוץ, המקום בכל ערוץ בנפרד, וכמה חסר כדי לעלות מקום. ומעליהם — כמה המרוץ סגור." },
  { key: "combos", label: "חמישיות", help: "שילובי אלבומים שחוזרים על עצמם בפתקים שונים, בלי תלות בסדר שבו נבחרו." },
  { key: "timing", label: "זמן ההצבעה", help: "כמה זמן לוקחת הצבעה מהכניסה ועד האישור, בנפרד לאתר ולקו, לפי שלב, ובכמה ביקורים או שיחות הושלמה." },
  { key: "people", label: "מי מצביע", help: "מצביעים חוזרים, השוואה לסקר הקודם באותה נקודת זמן, מי התחיל ולא סיים, והצטרפות לרשימת התפוצה." },
  { key: "ops", label: "תפעול ותוכן", help: "מחשבים חסומים, יומן הניהול בקו, ומה חסר בתוכן כדי שהאתר והקו יהיו שלמים." },
];

const KIND_LABEL: Record<Kind, string> = { albums: "אלבומים", songs: "שירים", artists: "זמרים" };
const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const fmtDate = (seconds?: number | null) => (seconds ? new Date(seconds * 1000).toLocaleDateString("he-IL", { day: "numeric", month: "short" }) : "");
const fmtDateTime = (seconds?: number | null) => (seconds ? new Date(seconds * 1000).toLocaleString("he-IL") : "");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  if (total < 60) return `${total} שנ׳`;
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  if (hours >= 24) { const days = Math.floor(hours / 24); return `${days} ימים ו-${hours % 24} שע׳`; }
  if (hours) return `${hours} שע׳ ${minutes} דק׳`;
  return rest ? `${minutes} דק׳ ${rest} שנ׳` : `${minutes} דק׳`;
}

/**
 * הפורמטר היחיד של המסך. `n` הוא מספר שאינו ספירת מצביעים (ימים, פריטים,
 * שניות) ולכן מוצג תמיד; `count` היא ספירה ולכן מתחלפת באחוז כשהמצב דולק.
 */
type Formatter = {
  percentOnly: boolean;
  n(value: number): string;
  count(votes: number, whole?: number): string;
  votes(votes: number, whole?: number): string;
};
function useFormatter(percentOnly: boolean, total: number): Formatter {
  return useMemo(() => {
    const n = (value: number) => Number(value || 0).toLocaleString("he-IL");
    const count = (votes: number, whole = total) => (percentOnly ? `${pct(votes, whole)}%` : n(votes));
    return { percentOnly, n, count, votes: (votes: number, whole = total) => (percentOnly ? `${pct(votes, whole)}%` : `${n(votes)} קולות`) };
  }, [percentOnly, total]);
}

export function AnalyticsPanel({ onMessage }: { onMessage(text: string): void }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [percentOnly, setPercentOnly] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [section, setSection] = useState<Section>("pace");

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/analytics${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setData(body as Analytics);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "טעינת הנתונים המתקדמים נכשלה.");
    } finally { setLoading(false); }
  }, [onMessage]);
  // הטעינה אינה נקראת סינכרונית מתוך האפקט, כמו בשאר מסכי האתר, כדי שלא
  // תיצור רינדור נוסף מיד בכניסה.
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const total = data?.totals.ballots ?? 0;
  const format = useFormatter(percentOnly, total);
  const active = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0];

  if (loading && !data) return <section className="admin-panel"><h2>נתונים מתקדמים</h2><p>מחשבים את הנתונים…</p></section>;
  if (!data) return <section className="admin-panel"><h2>נתונים מתקדמים</h2><p>לא הצלחנו לטעון את הנתונים.</p><button type="button" className="analytics-button" onClick={() => void load(true)}>ניסיון חוזר</button></section>;

  return <div className="analytics">
    {broadcast && <BroadcastScreen initial={data} percentOnly={percentOnly} onClose={() => setBroadcast(false)} />}
    <section className="admin-panel">
      <h2>נתונים מתקדמים</h2>
      <p className="panel-help">ניתוחים על הסקר הפעיל, מעבר לדירוג שבלשונית התוצאות. הנתונים מחושבים מהפתקים עצמם ומתעדכנים כל רבע דקה; „רענון” מושך חישוב טרי.</p>
      <div className="analytics-toolbar">
        <label className="analytics-switch"><input type="checkbox" checked={percentOnly} onChange={(event) => setPercentOnly(event.target.checked)} /> אחוזים בלבד <small>להסתרת מספרים מדויקים בצילום מסך</small></label>
        <button type="button" className="analytics-button" onClick={() => void load(true)} disabled={loading}>{loading ? "מרענן…" : "רענון"}</button>
        <button type="button" className="analytics-button" onClick={() => downloadTablesXlsx(buildSheets(data), "rosh-berosh-analytics.xlsx")}>הורדת Excel</button>
        <button type="button" className="analytics-button primary" onClick={() => setBroadcast(true)}>מסך שידור</button>
      </div>
      <div className="analytics-stats">
        <Stat label="פתקים" value={percentOnly ? "100%" : format.n(total)} />
        <Stat label="מהאתר" value={format.count(data.totals.site)} />
        <Stat label="מהטלפון" value={format.count(data.totals.phone)} />
        <Stat label="הצבעה ראשונה" value={fmtDate(data.totals.firstAt) || "—"} />
        <Stat label="הצבעה אחרונה" value={fmtDate(data.totals.lastAt) || "—"} />
      </div>
      <ChannelSplit site={data.totals.site} phone={data.totals.phone} formatValue={(value) => format.count(value)} />
    </section>

    <nav className="analytics-nav" aria-label="נושאי הנתונים">
      {SECTIONS.map((item) => <button key={item.key} type="button" className={item.key === section ? "active" : ""} aria-current={item.key === section ? "page" : undefined} onClick={() => setSection(item.key)}>{item.label}</button>)}
    </nav>

    <section className="admin-panel">
      <h2>{active.label}</h2>
      <p className="panel-help">{active.help}</p>
      {section === "pace" && <PaceSection data={data} format={format} />}
      {section === "when" && <WhenSection data={data} format={format} />}
      {section === "race" && <RaceSection data={data} format={format} />}
      {section === "albums" && <><AlbumBreakdownList data={data} format={format} /><StageDropoff data={data} format={format} /><ZeroVotes data={data} format={format} /></>}
      {section === "cross" && <CrossSections data={data} format={format} />}
      {section === "gaps" && <><ConcentrationCards data={data} format={format} /><GapsTable data={data} format={format} /></>}
      {section === "combos" && <>
        <p className="analytics-note">{format.count(data.combos.distinct)} שילובים שונים · {format.count(data.combos.repeated)} פתקים שיש להם לפחות תאום אחד</p>
        {data.combos.top.length ? <ol className="combo-list">{data.combos.top.map((combo, index) => <li key={index}><b>{format.votes(combo.votes)}</b><span>{combo.albums.join(" · ")}</span></li>)}</ol> : <p className="analytics-empty">עדיין אין פתקים.</p>}
      </>}
      {section === "timing" && <TimingSection data={data} format={format} />}
      {section === "people" && <PeopleSection data={data} format={format} />}
      {section === "ops" && <><OpsSection data={data} format={format} /><ContentSection data={data} format={format} /></>}
    </section>
  </div>;
}

function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "warn" | "ok" }) {
  return <article className={tone}><small>{label}</small><b>{value}</b>{note ? <span>{note}</span> : null}</article>;
}

const CHANNEL_LEGEND = [{ label: CHANNEL_LABEL.site, color: CHANNEL_COLOR.site }, { label: CHANNEL_LABEL.phone, color: CHANNEL_COLOR.phone }];

function PaceSection({ data, format }: { data: Analytics; format: Formatter }) {
  const trend = (value: number | null) => (value === null ? "—" : `${value > 0 ? "+" : ""}${value}%`);
  return <>
    <div className="analytics-stats">
      {data.pace.windows.map((window) => <Stat key={window.label} label={window.label} value={format.count(window.votes)}
        note={<>לעומת {format.count(window.previous)} בתקופה הקודמת · <b className={window.changePercent !== null && window.changePercent < 0 ? "down" : "up"}>{trend(window.changePercent)}</b></>} />)}
      <Stat label="ממוצע ליום" value={format.count(data.pace.perDay)} />
      <Stat label="שקט" value={data.pace.quietHours === null ? "—" : `${format.n(data.pace.quietHours)} שע׳`} note="מאז ההצבעה האחרונה" tone={data.pace.quietHours !== null && data.pace.quietHours >= 24 ? "warn" : undefined} />
    </div>
    <h3 className="chart-title">קו מצטבר מתחילת הסקר</h3>
    <CumulativeChart series={data.daily.series} label="הצבעות מצטברות" formatValue={(value) => format.count(value)} />
    <ChartLegend items={CHANNEL_LEGEND} />
    <h3 className="chart-title">הצבעות בכל יום{data.daily.peak ? ` · יום השיא ${fmtDate(data.daily.peak.bucket)} עם ${format.count(data.daily.peak.total)}` : ""}</h3>
    <DailyColumns series={data.daily.series} formatValue={(value) => format.count(value)} />
    <ChartLegend items={CHANNEL_LEGEND} />
    <div className="gaps-table-wrap"><table className="gaps-table daily-table">
      <caption className="table-caption">הצבעות לפי יום, מהאחרון לראשון</caption>
      <thead><tr><th>יום</th><th>אתר</th><th>טלפון</th><th>סה״כ</th><th>מצטבר</th></tr></thead><tbody>
      {[...data.daily.series].reverse().map((point) => <tr key={point.bucket}><td>{fmtDate(point.bucket)}</td><td>{format.count(point.site)}</td><td>{format.count(point.phone)}</td><td>{format.count(point.total)}</td><td>{format.count(point.cumulative)}</td></tr>)}
    </tbody></table></div>
  </>;
}

function WhenSection({ data, format }: { data: Analytics; format: Formatter }) {
  const byWeekday = data.activity.cells.map((row, weekday) => ({ weekday, total: row.reduce((sum, value) => sum + value, 0) }));
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, total: data.activity.cells.reduce((sum, row) => sum + row[hour], 0) }));
  const topHours = [...byHour].sort((a, b) => b.total - a.total).slice(0, 3).filter((item) => item.total > 0);
  if (!data.activity.max) return <p className="analytics-empty">עדיין אין הצבעות.</p>;
  return <>
    <ActivityHeatmap cells={data.activity.cells} formatValue={(value) => format.count(value)} />
    <HeatLegend max={data.activity.max} formatValue={(value) => format.count(value)} />
    <p className="analytics-note">
      {data.daily.peakHour ? `השעה החזקה ביותר: ${WEEKDAYS[data.daily.peakHour.weekday]} ב-${String(data.daily.peakHour.hour).padStart(2, "0")}:00 עם ${format.count(data.daily.peakHour.votes)}. ` : ""}
      {topHours.length ? `השעות המובילות בכל השבוע: ${topHours.map((item) => `${String(item.hour).padStart(2, "0")}:00`).join(", ")}.` : ""}
    </p>
    <div className="gaps-table-wrap"><table className="gaps-table"><caption className="table-caption">פעילות לפי יום בשבוע</caption><thead><tr><th>יום</th><th>הצבעות</th><th>חלק מהשבוע</th></tr></thead><tbody>
      {byWeekday.map((row) => <tr key={row.weekday}><td>{WEEKDAYS[row.weekday]}</td><td>{format.count(row.total)}</td><td>{pct(row.total, data.totals.ballots)}%</td></tr>)}
    </tbody></table></div>
  </>;
}

function RaceSection({ data, format }: { data: Analytics; format: Formatter }) {
  const [kind, setKind] = useState<"albums" | "artists">("albums");
  const lines = data.race[kind];
  return <>
    <div className="result-tabs analytics-tabs">
      <button type="button" className={kind === "albums" ? "active" : ""} onClick={() => setKind("albums")}>אלבומים</button>
      <button type="button" className={kind === "artists" ? "active" : ""} onClick={() => setKind("artists")}>זמרים</button>
    </div>
    <RaceChart lines={lines} formatValue={(value) => format.count(value)} />
    {lines.length > 0 && <div className="gaps-table-wrap"><table className="gaps-table"><caption className="table-caption">קולות מצטברים בסוף כל יום</caption><thead><tr><th>יום</th>{lines.map((line) => <th key={line.id}>{line.title}</th>)}</tr></thead><tbody>
      {(lines[0]?.points ?? []).map((point, index) => <tr key={point.bucket}><td>{dayLabel(point.bucket)}</td>{lines.map((line) => <td key={line.id}>{format.count(line.points[index]?.cumulative ?? 0)}</td>)}</tr>)}
    </tbody></table></div>}
  </>;
}

function AlbumBreakdownList({ data, format }: { data: Analytics; format: Formatter }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = data.albumBreakdown;
  // הפריט הפתוח נבדק מול הנתונים הנוכחיים: אחרי רענון שבו האלבום נמחק,
  // המפתח פשוט אינו נמצא ושום דבר אינו נפתח לריק.
  const openId = list.some((album) => album.id === expanded) ? expanded : null;
  if (!list.length) return <p className="analytics-empty">אין אלבומים בסקר.</p>;
  return <div className="album-breakdown">{list.map((album) => {
    const spread = album.songs.filter((song) => song.votes > 0).length;
    const isOpen = openId === album.id;
    return <article key={album.id} className={isOpen ? "open" : ""}>
      <button type="button" onClick={() => setExpanded(isOpen ? null : album.id)} aria-expanded={isOpen}>
        {album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <span className="album-breakdown-cover" aria-hidden="true">♫</span>}
        <span className="album-breakdown-main"><b>{album.title}</b><small>{album.artistName} · {format.votes(album.votes)} לאלבום</small></span>
        <span className="album-breakdown-top">{album.topSong ? <><b>{album.topSong.title}</b><small>{album.topSong.share}% מקולות השירים{spread > 1 ? ` · ${album.concentration >= 60 ? "שיר אחד לוקח הכול" : album.concentration >= 40 ? "מוביל ברור" : "קולות מפוזרים"}` : ""}</small></> : <small>עדיין אין קולות לשירים</small>}</span>
        <i aria-hidden="true">{isOpen ? "▲" : "▼"}</i>
      </button>
      {isOpen && <div className="album-breakdown-songs">{album.songs.length
        ? <RankBars initial={album.songs.length} items={album.songs.map((song) => ({ id: song.id, title: song.title, value: song.votes, display: format.percentOnly ? `${song.share}%` : `${format.n(song.votes)} · ${song.share}%` }))} formatValue={(value) => format.count(value)} />
        : <p className="analytics-empty">לאלבום אין שירים.</p>}</div>}
    </article>;
  })}</div>;
}

function StageDropoff({ data, format }: { data: Analytics; format: Formatter }) {
  if (!data.stageDropoff.length) return null;
  return <div className="zero-votes">
    <h3>נבחרו כאלבום אך לא נבחר מהם שיר</h3>
    <p className="analytics-note">כשהשלב פעיל זה אמור להיות אפס. ערך גבוה מצביע על פתקים חלקיים או על אלבום שאין בו שירים פעילים.</p>
    <ul className="ops-list">{data.stageDropoff.slice(0, 12).map((row) => <li key={row.id}><b>{row.title}</b><small>{format.count(row.withoutSong, row.albumVotes)} מתוך {format.count(row.albumVotes)} · {row.share}%</small></li>)}</ul>
  </div>;
}

function ZeroVotes({ data, format }: { data: Analytics; format: Formatter }) {
  const groups: Array<[string, Array<{ id: string; title: string; subtitle?: string; active: number }>]> = [["אלבומים", data.zeroVotes.albums], ["שירים", data.zeroVotes.songs], ["זמרים", data.zeroVotes.artists]];
  const any = groups.some(([, list]) => list.length);
  return <div className="zero-votes">
    <h3>בלי אף קול</h3>
    {any ? <div className="zero-votes-groups">{groups.map(([label, list]) => <div key={label}><b>{label} <small>({format.n(list.length)})</small></b>{list.length ? <ul>{list.map((item) => <li key={item.id}>{item.title}{item.subtitle ? <small> · {item.subtitle}</small> : null}{!item.active && <em>מוסתר</em>}</li>)}</ul> : <p className="analytics-empty">כולם קיבלו קולות.</p>}</div>)}</div> : <p className="analytics-empty">כל הפריטים קיבלו לפחות קול אחד.</p>}
  </div>;
}

function CrossSections({ data, format }: { data: Analytics; format: Formatter }) {
  const [artistId, setArtistId] = useState<string>("");
  const [albumId, setAlbumId] = useState<string>("");
  const artist = data.artistAlbums.find((item) => item.id === artistId) || data.artistAlbums[0];
  const album = data.albumCompanions.find((item) => item.id === albumId) || data.albumCompanions[0];
  return <div className="cross-grid">
    <div className="cross-card">
      <h3>זמר ← אלבומים</h3>
      {artist ? <>
        <select value={artist.id} onChange={(event) => setArtistId(event.target.value)} aria-label="בחירת זמר">{data.artistAlbums.map((item) => <option key={item.id} value={item.id}>{item.name} ({format.count(item.votes)})</option>)}</select>
        <p className="analytics-note">מי שהצביע ל{artist.name} בחר גם את:</p>
        <RankBars initial={5} items={artist.top.map((item) => ({ id: item.id, title: item.title, value: item.votes, display: `${item.share}%` }))} formatValue={(value) => format.count(value)} />
        {artist.own.length ? <><p className="analytics-note">האלבומים של {artist.name} עצמו:</p><ul className="own-list">{artist.own.map((item) => <li key={item.id}><b>{item.title}</b><small>{item.ofArtistVoters}% ממצביעי הזמר בחרו גם את האלבום · {item.ofAlbumVoters}% ממצביעי האלבום בחרו גם את הזמר · {format.votes(item.albumVotes)} לאלבום</small></li>)}</ul></> : <p className="analytics-note">לא נמצא אלבום ששם האמן שלו תואם לשם הזמר.</p>}
      </> : <p className="analytics-empty">עדיין אין קולות לזמרים.</p>}
    </div>
    <div className="cross-card">
      <h3>מי שבחר את… בחר גם</h3>
      {album ? <>
        <select value={album.id} onChange={(event) => setAlbumId(event.target.value)} aria-label="בחירת אלבום">{data.albumCompanions.map((item) => <option key={item.id} value={item.id}>{item.title} ({format.count(item.votes)})</option>)}</select>
        <RankBars initial={5} items={album.top.map((item) => ({ id: item.id, title: item.title, value: item.votes, display: `${item.share}%` }))} formatValue={(value) => format.count(value)} />
      </> : <p className="analytics-empty">עדיין אין קולות לאלבומים.</p>}
    </div>
    <div className="cross-card">
      <h3>צמדי זמרים נפוצים</h3>
      {data.artistPairs.length ? <ol className="pair-list">{data.artistPairs.map((pair, index) => <li key={index}><span>{pair.a} + {pair.b}</span><strong>{format.votes(pair.votes)}</strong><small>{pair.shareOfA}% ממצביעי {pair.a} · {pair.shareOfB}% ממצביעי {pair.b}</small></li>)}</ol> : <p className="analytics-empty">אין עדיין פתקים עם יותר מזמר אחד.</p>}
    </div>
  </div>;
}

function ConcentrationCards({ data, format }: { data: Analytics; format: Formatter }) {
  const verdict = (index: number) => (index >= 45 ? "מרוץ סגור סביב מוביל אחד" : index >= 20 ? "יש מוביל, אך יש תחרות" : "מרוץ פתוח");
  const biasText = (kind: Kind) => {
    const bias = data.positionBias[kind];
    if (bias.correlation === null) return "אין מספיק שונות כדי לבדוק";
    const direction = bias.correlation < 0 ? "פריטים בראש הרשימה מקבלים יותר" : "פריטים בסוף הרשימה מקבלים יותר";
    return bias.verdict === "none" ? "אין קשר בין המיקום ברשימה לקולות" : `${direction} (${bias.verdict === "clear" ? "קשר ברור" : "קשר חלש"}, ${bias.correlation})`;
  };
  return <div className="analytics-stats concentration-stats">
    {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => {
      const value = data.concentration[kind];
      return <Stat key={kind} label={`ריכוזיות · ${KIND_LABEL[kind]}`} value={`${value.index}`}
        note={<>{verdict(value.index)}. חמשת הראשונים מחזיקים {value.topFiveShare}%, ו-{format.n(value.itemsForHalf)} פריטים מחזיקים חצי.{value.leadPercent !== null ? ` המוביל לפני השני ב-${value.leadPercent}%.` : ""} <br />הטיית מיקום: {biasText(kind)}</>} />;
    })}
  </div>;
}

function GapsTable({ data, format }: { data: Analytics; format: Formatter }) {
  const [kind, setKind] = useState<Kind>("albums");
  const list = data.rankings[kind];
  return <>
    <div className="result-tabs analytics-tabs">{(Object.keys(KIND_LABEL) as Kind[]).map((key) => <button key={key} type="button" className={key === kind ? "active" : ""} onClick={() => setKind(key)}>{KIND_LABEL[key]}</button>)}</div>
    <div className="gaps-table-wrap"><table className="gaps-table">
      <caption className="table-caption">דירוג {KIND_LABEL[kind]} לפי ערוץ, עם הפער למקום שמעל</caption>
      <thead><tr><th>מקום</th><th>{KIND_LABEL[kind]}</th><th>סה״כ</th><th>אתר</th><th>טלפון</th><th>מקום באתר</th><th>מקום בטלפון</th><th>חסר לעלות</th><th>יתרון על הבא</th></tr></thead><tbody>
      {list.map((item) => <tr key={item.id} className={item.sitePlace && item.phonePlace && Math.abs(item.sitePlace - item.phonePlace) >= 3 ? "diverging" : ""}>
        <td><b>{item.place}</b></td>
        <td>{item.title}{item.subtitle ? <small>{item.subtitle}</small> : null}</td>
        <td>{format.count(item.votes)}</td>
        <td>{format.count(item.site)}</td>
        <td>{format.count(item.phone)}</td>
        <td>{item.sitePlace || "—"}</td>
        <td>{item.phonePlace || "—"}</td>
        <td>{item.gapAbove === null ? "—" : format.count(item.gapAbove + 1)}</td>
        <td>{item.gapBelow === null ? "—" : format.count(item.gapBelow)}</td>
      </tr>)}
    </tbody></table></div>
    <p className="analytics-note">„חסר לעלות” הוא קול אחד יותר מהפער, כי תיקו אינו עלייה. שורה מודגשת: הפרש של שלושה מקומות או יותר בין דירוג האתר לדירוג הטלפון.</p>
  </>;
}

function TimingSection({ data, format }: { data: Analytics; format: Formatter }) {
  const channels: Array<["all" | "site" | "phone", string]> = [["all", "כולם יחד"], ["site", "אתר"], ["phone", "טלפון"]];
  const stages: Array<[keyof Analytics["timing"]["all"]["stages"], string]> = [["albums", "בחירת אלבומים"], ["songs", "בחירת שירים"], ["artists", "בחירת זמרים"], ["summary", "אישור ושליחה"]];
  if (!data.timing.all.overall.count) return <p className="analytics-empty">עדיין אין פתקים עם מדידת זמן. המדידה מתחילה בהצבעות שנשלחות מעכשיו, באתר ובקו.</p>;
  return <div className="timing">
    <div className="analytics-stats timing-stats">{channels.map(([key, label]) => {
      const channel = data.timing[key];
      if (!channel.overall.count) return <Stat key={key} label={label} value="—" note="אין עדיין מדידות בערוץ הזה" />;
      return <article key={key} className={key}>
        <small>{label} · {format.count(channel.overall.count)}</small>
        <b>{fmtDuration(channel.overall.median)}</b>
        <span>חציון · ממוצע {fmtDuration(channel.overall.average)}</span>
        <span>מחצית המצביעים בין {fmtDuration(channel.overall.p25)} ל-{fmtDuration(channel.overall.p75)}</span>
        <span>סה״כ זמן שהושקע: <strong>{fmtDuration(channel.overall.total)}</strong></span>
        <span>המהיר {fmtDuration(channel.fastest)} · האיטי {fmtDuration(channel.slowest)}</span>
      </article>;
    })}</div>
    {data.timing.sampled
      ? <p className="analytics-note">המדידה מחושבת על {format.n(data.timing.sampleSize)} הפתקים האחרונים, כדי לא למשוך את כל הסקר לזיכרון.</p>
      : data.timing.untracked > 0 && <p className="analytics-note">{format.count(data.timing.untracked)} פתקים נשלחו לפני שהמדידה נוספה ואינם נספרים כאן.</p>}
    <div className="timing-grid">
      <div className="cross-card">
        <h3>זמן לפי שלב (חציון)</h3>
        <table className="timing-table"><thead><tr><th>שלב</th>{channels.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>
          {stages.map(([stage, label]) => <tr key={stage}><td>{label}</td>{channels.map(([key]) => { const summary = data.timing[key].stages[stage]; return <td key={key}>{summary.count ? <>{fmtDuration(summary.median)}<small>ממוצע {fmtDuration(summary.average)}</small></> : "—"}</td>; })}</tr>)}
        </tbody></table>
      </div>
      <div className="cross-card">
        <h3>התפלגות משך ההצבעה</h3>
        {channels.map(([key, label]) => data.timing[key].overall.count > 0 && <div key={key} className="timing-dist"><b>{label}</b>
          <RankBars initial={6} items={data.timing[key].distribution.map((bucket) => ({ id: `${key}-${bucket.label}`, title: bucket.label, value: bucket.share, display: `${bucket.share}%` }))} formatValue={(value) => `${value}%`} />
        </div>)}
      </div>
      <div className="cross-card">
        <h3>בכמה ביקורים או שיחות הושלמה ההצבעה</h3>
        {channels.map(([key, label]) => data.timing[key].sessions.some((bucket) => bucket.count > 0) && <div key={key} className="timing-dist"><b>{label}</b>
          <RankBars initial={3} items={data.timing[key].sessions.map((bucket) => ({ id: `${key}-${bucket.label}`, title: bucket.label, value: bucket.share, display: `${bucket.share}%` }))} formatValue={(value) => `${value}%`} />
        </div>)}
      </div>
    </div>
  </div>;
}

function PeopleSection({ data, format }: { data: Analytics; format: Formatter }) {
  const previous = data.returning.previous;
  return <>
    <div className="analytics-stats">
      <Stat label="מצביעים חוזרים" value={format.count(data.returning.voters)} note={`${data.returning.share}% ממצביעי הסקר הזה הצביעו גם בסקר קודם`} />
      <Stat label="השלמת הצבעה" value={data.abandoned.completionRate === null ? "—" : `${data.abandoned.completionRate}%`} note={`${format.count(data.abandoned.siteTotal + data.abandoned.phoneTotal)} התחילו ולא סיימו${data.abandoned.phoneTruncated ? " (לפחות)" : ""}`} tone={data.abandoned.completionRate !== null && data.abandoned.completionRate < 70 ? "warn" : undefined} />
      <Stat label="רשימת התפוצה" value={`${data.subscribers.share}%`} note={<>{format.count(data.subscribers.fromThisSurvey, data.totals.site)} ממצביעי האתר נרשמו · {format.n(data.subscribers.total)} נמענים פעילים סך הכול</>} />
      {previous && <Stat label={`מול „${previous.name}”`} value={previous.atSameElapsed === null ? "—" : format.count(previous.atSameElapsed, previous.total || 1)}
        note={<>היו לו {format.count(previous.atSameElapsed ?? 0, previous.total || 1)} באותה נקודת זמן, ו-{format.count(previous.total, previous.total || 1)} בסוף</>} />}
    </div>
    <div className="timing-grid">
      <div className="cross-card">
        <h3>איפה עוצרים באתר</h3>
        {data.abandoned.site.length
          ? <RankBars initial={6} items={data.abandoned.site.map((row) => ({ id: String(row.stage), title: row.label, subtitle: row.newestAt ? `אחרון: ${fmtDateTime(row.newestAt)}` : undefined, value: row.count, display: format.count(row.count, data.abandoned.siteTotal || 1) }))} formatValue={(value) => format.count(value)} />
          : <p className="analytics-empty">אין טיוטות פתוחות באתר.</p>}
        <p className="analytics-note">טיוטה נמחקת ברגע שההצבעה נשלחת, ולכן מה שנשאר כאן הוא באמת מי שלא סיים. בקו יש {format.count(data.abandoned.phoneTotal, data.abandoned.phoneTotal || 1)} טיוטות פתוחות{data.abandoned.phoneTruncated ? " לפחות" : ""}.</p>
      </div>
      <div className="cross-card">
        <h3>סקרים קודמים</h3>
        {data.returning.surveys.length > 1
          ? <div className="gaps-table-wrap"><table className="gaps-table"><thead><tr><th>סקר</th><th>הצבעה ראשונה</th><th>סה״כ הצבעות</th></tr></thead><tbody>
            {data.returning.surveys.map((survey) => <tr key={survey.id}><td>{survey.name}</td><td>{fmtDate(survey.firstAt) || "—"}</td><td>{format.count(survey.total, survey.total || 1)}</td></tr>)}
          </tbody></table></div>
          : <p className="analytics-empty">זה הסקר הראשון שיש בו הצבעות.</p>}
      </div>
    </div>
  </>;
}

function OpsSection({ data, format }: { data: Analytics; format: Formatter }) {
  return <div className="timing-grid ops-grid">
    <div className="cross-card">
      <h3>מחשבים חסומים <small>({format.n(data.blocked.length)})</small></h3>
      {data.blocked.length ? <ul className="ops-list">{data.blocked.map((item) => <li key={item.fingerprint}><b>{item.fingerprint.slice(0, 12)}…</b><small>נחסם {fmtDateTime(item.createdAt)} על ידי {item.blockedBy} · {format.count(item.ballots)} פתקים מהמחשב הזה{item.lastBallotAt ? ` · אחרון ${fmtDateTime(item.lastBallotAt)}` : ""}</small></li>)}</ul> : <p className="analytics-empty">אין מחשבים חסומים בסקר הזה.</p>}
      <p className="analytics-note">ניסיון הצבעה שנחסם אינו נשמר כפתק, ולכן נספר כאן רק מה שנכנס לפני החסימה.</p>
    </div>
    <div className="cross-card">
      <h3>יומן הניהול בקו <small>({format.n(data.audit.last30Days.total)} פעולות ב-30 יום, {format.n(data.audit.last30Days.failed)} נכשלו)</small></h3>
      {data.audit.recent.length ? <ul className="ops-list">{data.audit.recent.map((row) => <li key={row.id} className={row.status >= 400 ? "failed" : ""}><b>{row.action}{row.target ? ` · ${row.target}` : ""}</b><small>{row.phone} · {fmtDateTime(row.createdAt)} · {row.status >= 400 ? `נכשל (${row.status})` : "הצליח"}</small></li>)}</ul> : <p className="analytics-empty">עדיין אין פעולות ניהול מהקו.</p>}
    </div>
  </div>;
}

function ContentSection({ data, format }: { data: Analytics; format: Formatter }) {
  const groups: Array<[string, Array<{ id: string; title: string; subtitle?: string }>]> = [
    ["שירים בלי קובץ שמע", data.content.songsWithoutAudio],
    ["שירים בלי קטע השמעה", data.content.songsWithoutPreview],
    ["אלבומים בלי עטיפה", data.content.albumsWithoutCover],
    ["זמרים בלי תמונה", data.content.artistsWithoutImage],
    ["קריינויות חסרות לקו", data.content.missingPrompts],
  ];
  return <div className="content-status">
    <div className="analytics-stats">
      {groups.map(([label, list]) => <Stat key={label} label={label} value={format.n(list.length)} tone={list.length ? "warn" : "ok"} />)}
      <Stat label="מוסתרים" value={format.n(data.content.inactive.albums + data.content.inactive.songs + data.content.inactive.artists)} note={`${data.content.inactive.albums} אלבומים · ${data.content.inactive.songs} שירים · ${data.content.inactive.artists} זמרים`} />
    </div>
    <div className="zero-votes-groups">{groups.filter(([, list]) => list.length).map(([label, list]) => <div key={label}><b>{label}</b><ul>{list.slice(0, 40).map((item) => <li key={item.id}>{item.title}{item.subtitle ? <small> · {item.subtitle}</small> : null}</li>)}{list.length > 40 && <li><small>ועוד {format.n(list.length - 40)}…</small></li>}</ul></div>)}</div>
    {groups.every(([, list]) => !list.length) && <p className="analytics-empty">התוכן שלם: לכל השירים יש שמע וקטע השמעה, לכל האלבומים עטיפה, לכל הזמרים תמונה, ולכולם קריינות.</p>}
  </div>;
}

/** מסך שידור: תצוגה גדולה ונקייה למקרן, מתרעננת לבד. */
function BroadcastScreen({ initial, percentOnly, onClose }: { initial: Analytics; percentOnly: boolean; onClose(): void }) {
  const [data, setData] = useState(initial);
  const [kind, setKind] = useState<Kind>("albums");
  const [auto, setAuto] = useState(true);
  const autoRef = useRef(auto);
  const closeRef = useRef(onClose);
  const surface = useRef<HTMLDivElement | null>(null);
  const format = useFormatter(percentOnly, data.totals.ballots);
  useEffect(() => { autoRef.current = auto; }, [auto]);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  // אפקט אחד שאינו נבנה מחדש כשמשנים "מתחלף לבד": הרענון והסיבוב קוראים
  // את המצב דרך ref, ולכן שעון הרענון אינו מתאפס בכל לחיצה.
  useEffect(() => {
    const refresh = window.setInterval(() => {
      void fetch("/api/admin/analytics", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => { if (body) setData(body as Analytics); })
        .catch(() => undefined);
    }, 60_000);
    const rotate = window.setInterval(() => { if (autoRef.current) setKind((current) => (current === "albums" ? "songs" : current === "songs" ? "artists" : "albums")); }, 15_000);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    // הדף שמאחור אינו נגלל בזמן שהתצוגה פתוחה.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    surface.current?.focus();
    return () => {
      window.clearInterval(refresh); window.clearInterval(rotate);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const list = useMemo(() => data.rankings[kind].slice(0, 10), [data, kind]);
  const max = Math.max(1, ...list.map((item) => item.votes));
  return <div className="broadcast" dir="rtl" role="dialog" aria-modal="true" aria-label="תוצאות חיות" tabIndex={-1} ref={surface}>
    <header>
      <div><p className="kicker">ראש בראש · תוצאות חיות</p><h1>{KIND_LABEL[kind]}</h1></div>
      <div className="broadcast-controls">
        {(Object.keys(KIND_LABEL) as Kind[]).map((key) => <button key={key} type="button" className={key === kind ? "active" : ""} onClick={() => { setKind(key); setAuto(false); }}>{KIND_LABEL[key]}</button>)}
        <button type="button" className={auto ? "active" : ""} onClick={() => setAuto(!auto)}>{auto ? "מתחלף לבד" : "קבוע"}</button>
        <button type="button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }}>מסך מלא</button>
        <button type="button" onClick={onClose}>סגירה</button>
      </div>
    </header>
    <ol className="broadcast-list">{list.map((item: RankedItem) => <li key={item.id} style={{ "--fill": `${(item.votes / max) * 100}%` } as React.CSSProperties}>
      <b>{item.place}</b><span>{item.title}{item.subtitle ? <small>{item.subtitle}</small> : null}</span><strong>{format.count(item.votes)}</strong>
    </li>)}</ol>
    <footer>{percentOnly ? "" : `${format.n(data.totals.ballots)} הצבעות · `}עודכן {new Date(data.generatedAt * 1000).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</footer>
  </div>;
}

function buildSheets(data: Analytics): TableSheet[] {
  const ranking = (kind: Kind): TableSheet => ({ name: `דירוג ${KIND_LABEL[kind]}`, columns: ["מקום", KIND_LABEL[kind], "פירוט", "קולות", "אחוז מהפתקים", "אתר", "טלפון", "מקום באתר", "מקום בטלפון", "חסר לעלות מקום", "יתרון על הבא"], rows: data.rankings[kind].map((item) => [item.place, item.title, item.subtitle || "", item.votes, item.share, item.site, item.phone, item.sitePlace, item.phonePlace, item.gapAbove === null ? "" : item.gapAbove + 1, item.gapBelow ?? ""]) });
  const stageLabel = { albums: "בחירת אלבומים", songs: "בחירת שירים", artists: "בחירת זמרים", summary: "אישור ושליחה" } as const;
  const timingRows: TableSheet["rows"] = [];
  for (const [key, label] of [["all", "כולם"], ["site", "אתר"], ["phone", "טלפון"]] as const) {
    const channel = data.timing[key];
    timingRows.push([label, "כל ההצבעה", channel.overall.count, channel.overall.median, channel.overall.average, channel.overall.p25, channel.overall.p75, channel.overall.total]);
    for (const stage of ["albums", "songs", "artists", "summary"] as const) {
      const summary = channel.stages[stage];
      timingRows.push([label, stageLabel[stage], summary.count, summary.median, summary.average, summary.p25, summary.p75, summary.total]);
    }
  }
  const activityRows: TableSheet["rows"] = [];
  data.activity.cells.forEach((row, weekday) => row.forEach((value, hour) => { if (value) activityRows.push([WEEKDAYS[weekday], `${String(hour).padStart(2, "0")}:00`, value, data.activity.site[weekday][hour], data.activity.phone[weekday][hour]]); }));
  const raceRows = (kind: "albums" | "artists"): TableSheet["rows"] => data.race[kind].flatMap((line) => line.points.map((point) => [line.title, new Date(point.bucket * 1000).toLocaleDateString("he-IL"), point.cumulative]));

  return [
    ranking("albums"), ranking("songs"), ranking("artists"),
    { name: "שירים לפי אלבום", columns: ["אלבום", "אמן", "קולות לאלבום", "שיר", "קולות לשיר", "אחוז מקולות השירים", "שיר מוביל"], rows: data.albumBreakdown.flatMap((album) => album.songs.length ? album.songs.map((song) => [album.title, album.artistName, album.votes, song.title, song.votes, song.share, album.topSong?.id === song.id ? "כן" : ""]) : [[album.title, album.artistName, album.votes, "", 0, 0, ""]]) },
    { name: "בלי קולות", columns: ["סוג", "שם", "פירוט", "מוסתר"], rows: [...data.zeroVotes.albums.map((item) => ["אלבום", item.title, item.subtitle || "", item.active ? "" : "כן"]), ...data.zeroVotes.songs.map((item) => ["שיר", item.title, item.subtitle || "", item.active ? "" : "כן"]), ...data.zeroVotes.artists.map((item) => ["זמר", item.title, "", item.active ? "" : "כן"])] },
    { name: "קצב", columns: ["חלון", "הצבעות", "אתר", "טלפון", "בתקופה הקודמת", "שינוי באחוזים"], rows: data.pace.windows.map((window) => [window.label, window.votes, window.site, window.phone, window.previous, window.changePercent ?? ""]) },
    { name: "פעילות לפי שעה", columns: ["יום", "שעה", "סה״כ", "אתר", "טלפון"], rows: activityRows },
    { name: "מרוץ אלבומים", columns: ["אלבום", "יום", "קולות מצטברים"], rows: raceRows("albums") },
    { name: "מרוץ זמרים", columns: ["זמר", "יום", "קולות מצטברים"], rows: raceRows("artists") },
    { name: "ריכוזיות", columns: ["קטגוריה", "מדד ריכוזיות", "ג׳יני", "חלק חמשת הראשונים", "פריטים לחצי מהקולות", "יתרון המוביל באחוזים", "מתאם מיקום"], rows: (Object.keys(KIND_LABEL) as Kind[]).map((kind) => [KIND_LABEL[kind], data.concentration[kind].index, data.concentration[kind].gini, data.concentration[kind].topFiveShare, data.concentration[kind].itemsForHalf, data.concentration[kind].leadPercent ?? "", data.positionBias[kind].correlation ?? ""]) },
    { name: "זמר-אלבום", columns: ["זמר", "קולות לזמר", "אלבום", "בחרו את שניהם", "אחוז ממצביעי הזמר", "האלבום שלו"], rows: data.artistAlbums.flatMap((artist) => [...artist.top.map((item) => [artist.name, artist.votes, item.title, item.votes, item.share, ""]), ...artist.own.map((item) => [artist.name, artist.votes, item.title, item.both, item.ofArtistVoters, "כן"])]) },
    { name: "אלבומים יחד", columns: ["אלבום", "קולות", "נבחר יחד עם", "פתקים משותפים", "אחוז ממצביעי האלבום"], rows: data.albumCompanions.flatMap((album) => album.top.map((item) => [album.title, album.votes, item.title, item.votes, item.share])) },
    { name: "צמדי זמרים", columns: ["זמר א", "זמר ב", "פתקים משותפים", "אחוז ממצביעי א", "אחוז ממצביעי ב"], rows: data.artistPairs.map((pair) => [pair.a, pair.b, pair.votes, pair.shareOfA, pair.shareOfB]) },
    { name: "חמישיות", columns: ["שילוב", "פתקים", "אחוז מהפתקים"], rows: data.combos.top.map((combo) => [combo.albums.join(" · "), combo.votes, combo.share]) },
    { name: "זמן הצבעה", columns: ["ערוץ", "שלב", "פתקים", "חציון (שניות)", "ממוצע (שניות)", "רבעון תחתון", "רבעון עליון", "סה״כ (שניות)"], rows: timingRows },
    { name: "לפי יום", columns: ["יום", "אתר", "טלפון", "סה״כ", "מצטבר"], rows: data.daily.series.map((point) => [new Date(point.bucket * 1000).toLocaleDateString("he-IL"), point.site, point.phone, point.total, point.cumulative]) },
    { name: "מי לא סיים", columns: ["שלב", "טיוטות", "הישנה ביותר", "האחרונה"], rows: data.abandoned.site.map((row) => [row.label, row.count, row.oldestAt ? fmtDateTime(row.oldestAt) : "", row.newestAt ? fmtDateTime(row.newestAt) : ""]) },
    { name: "סקרים", columns: ["סקר", "הצבעה ראשונה", "סה״כ הצבעות", "באותה נקודת זמן"], rows: data.returning.surveys.map((survey) => [survey.name, survey.firstAt ? new Date(survey.firstAt * 1000).toLocaleDateString("he-IL") : "", survey.total, survey.id === data.returning.previous?.id ? data.returning.previous?.atSameElapsed ?? "" : ""]) },
    { name: "נשירה בין שלבים", columns: ["אלבום", "קולות לאלבום", "בלי בחירת שיר", "אחוז"], rows: data.stageDropoff.map((row) => [row.title, row.albumVotes, row.withoutSong, row.share]) },
    { name: "חסימות", columns: ["טביעת אצבע", "נחסם על ידי", "תאריך", "פתקים"], rows: data.blocked.map((item) => [item.fingerprint, item.blockedBy, fmtDateTime(item.createdAt), item.ballots]) },
    { name: "יומן הקו", columns: ["תאריך", "טלפון", "פעולה", "יעד", "סטטוס"], rows: data.audit.recent.map((row) => [fmtDateTime(row.createdAt), row.phone, row.action, row.target || "", row.status]) },
    { name: "מצב התוכן", columns: ["בעיה", "פריט", "פירוט"], rows: [...data.content.songsWithoutAudio.map((item) => ["שיר בלי שמע", item.title, item.subtitle || ""]), ...data.content.songsWithoutPreview.map((item) => ["שיר בלי קטע השמעה", item.title, item.subtitle || ""]), ...data.content.albumsWithoutCover.map((item) => ["אלבום בלי עטיפה", item.title, item.subtitle || ""]), ...data.content.artistsWithoutImage.map((item) => ["זמר בלי תמונה", item.title, ""]), ...data.content.missingPrompts.map((item) => ["קריינות חסרה", item.title, item.subtitle || ""])] },
  ];
}
