"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Analytics, RankedItem } from "./analytics-types";
import { downloadTablesXlsx, type TableSheet } from "./xlsx-export";
import "./analytics-panel.css";

/**
 * לשונית "נתונים מתקדמים": ניתוחים שנוספים לצד "תוצאות" ו"מצביעים" ואינם
 * משנים אותם. כל הנתונים מגיעים בבקשה אחת מ-/api/admin/analytics, והמסך
 * מחולק לקטעים שאפשר לפתוח ולסגור. "אחוזים בלבד" מסתיר את המספרים
 * המדויקים לצילום מסך; "מסך שידור" פותח תצוגה גדולה עם רענון אוטומטי.
 */

type Section = "albums" | "cross" | "gaps" | "combos" | "timing" | "daily" | "ops" | "content";
type Kind = "albums" | "songs" | "artists";

const KIND_LABEL: Record<Kind, string> = { albums: "אלבומים", songs: "שירים", artists: "זמרים" };
const fmtNumber = (value: number) => Number(value || 0).toLocaleString("he-IL");
const fmtDate = (seconds?: number | null) => (seconds ? new Date(seconds * 1000).toLocaleDateString("he-IL", { day: "numeric", month: "short" }) : "");
const fmtDateTime = (seconds?: number | null) => (seconds ? new Date(seconds * 1000).toLocaleString("he-IL") : "");
export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  if (total < 60) return `${total} שנ׳`;
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  if (hours >= 24) { const days = Math.floor(hours / 24); return `${days} ימים ו-${hours % 24} שע׳`; }
  if (hours) return `${hours} שע׳ ${minutes} דק׳`;
  return rest ? `${minutes} דק׳ ${rest} שנ׳` : `${minutes} דק׳`;
}

export function AnalyticsPanel({ onMessage }: { onMessage(text: string): void }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [percentOnly, setPercentOnly] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [open, setOpen] = useState<Record<Section, boolean>>({ albums: true, cross: true, gaps: true, combos: true, timing: true, daily: true, ops: false, content: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/analytics", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setData(body as Analytics);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "טעינת הנתונים המתקדמים נכשלה.");
    } finally { setLoading(false); }
  }, [onMessage]);
  useEffect(() => { let active = true; void (async () => { if (active) await load(); })(); return () => { active = false; }; }, [load]);

  // ערך להצגה: במצב "אחוזים בלבד" המספר המדויק מוחלף באחוז מכלל הפתקים.
  const count = useCallback((votes: number, share?: number) => (percentOnly ? `${share ?? 0}%` : `${fmtNumber(votes)} קולות`), [percentOnly]);
  const toggle = (key: Section) => setOpen((current) => ({ ...current, [key]: !current[key] }));

  const exportAll = () => {
    if (!data) return;
    downloadTablesXlsx(buildSheets(data), "rosh-berosh-analytics.xlsx");
  };

  if (loading && !data) return <section className="admin-panel"><h2>נתונים מתקדמים</h2><p>מחשבים את הנתונים…</p></section>;
  if (!data) return <section className="admin-panel"><h2>נתונים מתקדמים</h2><p>לא הצלחנו לטעון את הנתונים.</p><button type="button" className="analytics-button" onClick={() => void load()}>ניסיון חוזר</button></section>;

  const total = data.totals.ballots;
  return <div className="analytics">
    {broadcast && <BroadcastScreen initial={data} percentOnly={percentOnly} onClose={() => setBroadcast(false)} />}
    <section className="admin-panel">
      <h2>נתונים מתקדמים</h2>
      <p className="panel-help">ניתוחים על הסקר הפעיל, מעבר לדירוג שבלשונית התוצאות. הנתונים מחושבים בכל טעינה מהפתקים עצמם.</p>
      <div className="analytics-toolbar">
        <label className="analytics-switch"><input type="checkbox" checked={percentOnly} onChange={(event) => setPercentOnly(event.target.checked)} /> אחוזים בלבד</label>
        <button type="button" className="analytics-button" onClick={() => void load()} disabled={loading}>{loading ? "מרענן…" : "רענון"}</button>
        <button type="button" className="analytics-button" onClick={exportAll}>הורדת Excel של כל הנתונים</button>
        <button type="button" className="analytics-button primary" onClick={() => setBroadcast(true)}>מסך שידור</button>
      </div>
      <div className="analytics-stats">
        <Stat label="פתקים" value={percentOnly ? "100%" : fmtNumber(total)} />
        <Stat label="מהאתר" value={percentOnly ? `${pct(data.totals.site, total)}%` : fmtNumber(data.totals.site)} />
        <Stat label="מהטלפון" value={percentOnly ? `${pct(data.totals.phone, total)}%` : fmtNumber(data.totals.phone)} />
        <Stat label="הצבעה ראשונה" value={fmtDate(data.totals.firstAt) || "—"} />
        <Stat label="הצבעה אחרונה" value={fmtDate(data.totals.lastAt) || "—"} />
      </div>
    </section>

    <Block title="השיר המוביל בכל אלבום" help="לכל אלבום: השיר שקיבל הכי הרבה קולות, חלקו מכלל קולות השירים באלבום, ופיזור הקולות. לחיצה על אלבום פותחת את כל שיריו." open={open.albums} onToggle={() => toggle("albums")}>
      <AlbumBreakdownList data={data} count={count} percentOnly={percentOnly} />
      <ZeroVotes data={data} />
    </Block>

    <Block title="הצלבות" help="מה הולך עם מה: האלבומים של מי שהצביעו לזמר, אלבומים שנבחרים יחד, וצמדי זמרים." open={open.cross} onToggle={() => toggle("cross")}>
      <CrossSections data={data} count={count} />
    </Block>

    <Block title="אתר מול טלפון ופערים בין מקומות" help="לכל פריט: הקולות מכל ערוץ, המקום שלו בכל ערוץ בנפרד, וכמה קולות חסרים לו כדי לעלות מקום." open={open.gaps} onToggle={() => toggle("gaps")}>
      <GapsTable data={data} percentOnly={percentOnly} />
    </Block>

    <Block title="חמישיות אלבומים נפוצות" help="השילובים המלאים של אלבומים שחוזרים על עצמם בפתקים שונים." open={open.combos} onToggle={() => toggle("combos")}>
      <p className="analytics-note">{fmtNumber(data.combos.distinct)} שילובים שונים · {percentOnly ? `${pct(data.combos.repeated, total)}%` : fmtNumber(data.combos.repeated)} פתקים זהים לפתק אחר לפחות</p>
      {data.combos.top.length ? <ol className="combo-list">{data.combos.top.map((combo, index) => <li key={index}><b>{count(combo.votes, combo.share)}</b><span>{combo.albums.join(" · ")}</span></li>)}</ol> : <p className="analytics-empty">עדיין אין פתקים.</p>}
    </Block>

    <Block title="זמן ההצבעה" help="כמה זמן לוקחת הצבעה מהכניסה ועד האישור, בנפרד לאתר ולטלפון, לפי שלב, ובכמה ביקורים או שיחות היא הושלמה. נמדד רק בפתקים שנשלחו אחרי הוספת המדידה." open={open.timing} onToggle={() => toggle("timing")}>
      <TimingSection data={data} />
    </Block>

    <Block title="הצבעות לפי יום מאז הפתיחה" help="כל יום מההצבעה הראשונה, לפי ערוץ, עם מצטבר." open={open.daily} onToggle={() => toggle("daily")}>
      <DailyChart data={data} percentOnly={percentOnly} />
    </Block>

    <Block title="חסימות ויומן הקו" help="המחשבים החסומים בסקר הזה ופעולות הניהול שנעשו מהטלפון." open={open.ops} onToggle={() => toggle("ops")}>
      <OpsSection data={data} />
    </Block>

    <Block title="מצב התוכן" help="מה חסר כדי שהאתר והקו יהיו שלמים: שמע, עטיפות, קטעי השמעה, תמונות וקריינויות." open={open.content} onToggle={() => toggle("content")}>
      <ContentSection data={data} />
    </Block>
  </div>;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function Stat({ label, value }: { label: string; value: ReactNode }) { return <article><small>{label}</small><b>{value}</b></article>; }

function Block({ title, help, open, onToggle, children }: { title: string; help: string; open: boolean; onToggle(): void; children: ReactNode }) {
  return <section className={`admin-panel analytics-block${open ? " open" : ""}`}>
    <button type="button" className="analytics-block-head" onClick={onToggle} aria-expanded={open}><h2>{title}</h2><span aria-hidden="true">{open ? "−" : "+"}</span></button>
    {open && <><p className="panel-help">{help}</p>{children}</>}
  </section>;
}

function Bar({ share, tone }: { share: number; tone?: "site" | "phone" }) { return <i className={`analytics-bar${tone ? ` ${tone}` : ""}`} style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />; }

function AlbumBreakdownList({ data, count, percentOnly }: { data: Analytics; count(votes: number, share?: number): string; percentOnly: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = data.albumBreakdown;
  if (!list.length) return <p className="analytics-empty">אין אלבומים בסקר.</p>;
  return <div className="album-breakdown">{list.map((album) => {
    const spread = album.songs.filter((song) => song.votes > 0).length;
    const isOpen = expanded === album.id;
    return <article key={album.id} className={isOpen ? "open" : ""}>
      <button type="button" onClick={() => setExpanded(isOpen ? null : album.id)} aria-expanded={isOpen}>
        {album.coverUrl ? <img src={album.coverUrl} alt="" loading="lazy" /> : <span className="album-breakdown-cover">♫</span>}
        <span className="album-breakdown-main"><b>{album.title}</b><small>{album.artistName} · {count(album.votes, pct(album.votes, data.totals.ballots))} לאלבום</small></span>
        <span className="album-breakdown-top">{album.topSong ? <><b>{album.topSong.title}</b><small>{album.topSong.share}% מקולות השירים{spread > 1 ? ` · ${album.concentration >= 60 ? "שיר אחד לוקח הכול" : album.concentration >= 40 ? "מוביל ברור" : "קולות מפוזרים"}` : ""}</small></> : <small>עדיין אין קולות לשירים</small>}</span>
        <i aria-hidden="true">{isOpen ? "▲" : "▼"}</i>
      </button>
      {isOpen && <div className="album-breakdown-songs">{album.songs.length ? album.songs.map((song, index) => <div key={song.id}><b>{index + 1}</b><span>{song.title}</span><Bar share={song.share} /><strong>{percentOnly ? `${song.share}%` : `${fmtNumber(song.votes)} · ${song.share}%`}</strong></div>) : <p className="analytics-empty">לאלבום אין שירים.</p>}</div>}
    </article>;
  })}</div>;
}

function ZeroVotes({ data }: { data: Analytics }) {
  const groups: Array<[string, Array<{ id: string; title: string; subtitle?: string; active: number }>]> = [["אלבומים", data.zeroVotes.albums], ["שירים", data.zeroVotes.songs], ["זמרים", data.zeroVotes.artists]];
  const any = groups.some(([, list]) => list.length);
  return <div className="zero-votes">
    <h3>בלי אף קול</h3>
    {any ? <div className="zero-votes-groups">{groups.map(([label, list]) => <div key={label}><b>{label} <small>({list.length})</small></b>{list.length ? <ul>{list.map((item) => <li key={item.id}>{item.title}{item.subtitle ? <small> · {item.subtitle}</small> : null}{!item.active && <em>מוסתר</em>}</li>)}</ul> : <p className="analytics-empty">כולם קיבלו קולות.</p>}</div>)}</div> : <p className="analytics-empty">כל הפריטים קיבלו לפחות קול אחד.</p>}
  </div>;
}

function CrossSections({ data, count }: { data: Analytics; count(votes: number, share?: number): string }) {
  const [artistId, setArtistId] = useState<string>("");
  const [albumId, setAlbumId] = useState<string>("");
  const artist = data.artistAlbums.find((item) => item.id === artistId) || data.artistAlbums[0];
  const album = data.albumCompanions.find((item) => item.id === albumId) || data.albumCompanions[0];
  return <div className="cross-grid">
    <div className="cross-card">
      <h3>זמר ← אלבומים</h3>
      {artist ? <>
        <select value={artist.id} onChange={(event) => setArtistId(event.target.value)}>{data.artistAlbums.map((item) => <option key={item.id} value={item.id}>{item.name} ({fmtNumber(item.votes)})</option>)}</select>
        <p className="analytics-note">מי שהצביע ל{artist.name} בחר גם את:</p>
        <ul className="share-list">{artist.top.map((item) => <li key={item.id}><span>{item.title}</span><Bar share={item.share} /><strong>{item.share}%</strong></li>)}</ul>
        {artist.own.length ? <><p className="analytics-note">האלבומים של {artist.name} עצמו:</p><ul className="own-list">{artist.own.map((item) => <li key={item.id}><b>{item.title}</b><small>{item.ofArtistVoters}% ממצביעי הזמר בחרו גם את האלבום · {item.ofAlbumVoters}% ממצביעי האלבום בחרו גם את הזמר · {count(item.albumVotes)} לאלבום</small></li>)}</ul></> : <p className="analytics-note">לא נמצא אלבום ששם האמן שלו תואם לשם הזמר.</p>}
      </> : <p className="analytics-empty">עדיין אין קולות לזמרים.</p>}
    </div>
    <div className="cross-card">
      <h3>מי שבחר את… בחר גם</h3>
      {album ? <>
        <select value={album.id} onChange={(event) => setAlbumId(event.target.value)}>{data.albumCompanions.map((item) => <option key={item.id} value={item.id}>{item.title} ({fmtNumber(item.votes)})</option>)}</select>
        <ul className="share-list">{album.top.map((item) => <li key={item.id}><span>{item.title}</span><Bar share={item.share} /><strong>{item.share}%</strong></li>)}</ul>
      </> : <p className="analytics-empty">עדיין אין קולות לאלבומים.</p>}
    </div>
    <div className="cross-card">
      <h3>צמדי זמרים נפוצים</h3>
      {data.artistPairs.length ? <ol className="pair-list">{data.artistPairs.map((pair, index) => <li key={index}><span>{pair.a} + {pair.b}</span><strong>{count(pair.votes, pct(pair.votes, data.totals.ballots))}</strong><small>{pair.shareOfA}% ממצביעי {pair.a} · {pair.shareOfB}% ממצביעי {pair.b}</small></li>)}</ol> : <p className="analytics-empty">אין עדיין פתקים עם יותר מזמר אחד.</p>}
    </div>
  </div>;
}

function GapsTable({ data, percentOnly }: { data: Analytics; percentOnly: boolean }) {
  const [kind, setKind] = useState<Kind>("albums");
  const list = data.rankings[kind];
  const value = (votes: number, share: number) => (percentOnly ? `${share}%` : fmtNumber(votes));
  return <>
    <div className="result-tabs analytics-tabs">{(Object.keys(KIND_LABEL) as Kind[]).map((key) => <button key={key} type="button" className={key === kind ? "active" : ""} onClick={() => setKind(key)}>{KIND_LABEL[key]}</button>)}</div>
    <div className="gaps-table-wrap"><table className="gaps-table"><thead><tr><th>מקום</th><th>{KIND_LABEL[kind]}</th><th>סה״כ</th><th>אתר</th><th>טלפון</th><th>מקום באתר</th><th>מקום בטלפון</th><th>חסר לעלות</th><th>יתרון על הבא</th></tr></thead><tbody>
      {list.map((item) => <tr key={item.id} className={item.sitePlace && item.phonePlace && Math.abs(item.sitePlace - item.phonePlace) >= 3 ? "diverging" : ""}>
        <td><b>{item.place}</b></td>
        <td>{item.title}{item.subtitle ? <small>{item.subtitle}</small> : null}</td>
        <td>{value(item.votes, item.share)}</td>
        <td><span className="channel-cell"><Bar share={pct(item.site, Math.max(1, item.votes))} tone="site" />{value(item.site, pct(item.site, data.totals.ballots))}</span></td>
        <td><span className="channel-cell"><Bar share={pct(item.phone, Math.max(1, item.votes))} tone="phone" />{value(item.phone, pct(item.phone, data.totals.ballots))}</span></td>
        <td>{item.sitePlace || "—"}</td>
        <td>{item.phonePlace || "—"}</td>
        <td>{item.gapAbove === null ? "—" : item.gapAbove === 0 ? "תיקו" : percentOnly ? `${pct(item.gapAbove + 1, data.totals.ballots)}%` : `${fmtNumber(item.gapAbove + 1)}`}</td>
        <td>{item.gapBelow === null ? "—" : percentOnly ? `${pct(item.gapBelow, data.totals.ballots)}%` : fmtNumber(item.gapBelow)}</td>
      </tr>)}
    </tbody></table></div>
    <p className="analytics-note">שורה מודגשת: הפרש של שלושה מקומות או יותר בין דירוג האתר לדירוג הטלפון.</p>
  </>;
}

function TimingSection({ data }: { data: Analytics }) {
  const channels: Array<["all" | "site" | "phone", string]> = [["all", "כולם יחד"], ["site", "אתר"], ["phone", "טלפון"]];
  const stages: Array<[keyof Analytics["timing"]["all"]["stages"], string]> = [["albums", "בחירת אלבומים"], ["songs", "בחירת שירים"], ["artists", "בחירת זמרים"], ["summary", "אישור ושליחה"]];
  if (!data.timing.all.overall.count) return <p className="analytics-empty">עדיין אין פתקים עם מדידת זמן. המדידה מתחילה בהצבעות שנשלחות מעכשיו, באתר ובקו.</p>;
  return <div className="timing">
    <div className="analytics-stats timing-stats">{channels.map(([key, label]) => { const t = data.timing[key]; return <article key={key} className={key}><small>{label} · {fmtNumber(t.overall.count)} פתקים</small><b>{fmtDuration(t.overall.median)}</b><span>חציון · ממוצע {fmtDuration(t.overall.average)}</span><span>סה״כ זמן שכולם השקיעו: <strong>{fmtDuration(t.overall.total)}</strong></span><span>המהיר {fmtDuration(t.fastest)} · האיטי {fmtDuration(t.slowest)}</span></article>; })}</div>
    {data.timing.untracked > 0 && <p className="analytics-note">{fmtNumber(data.timing.untracked)} פתקים ישנים יותר נשלחו לפני שהמדידה נוספה ואינם נספרים כאן.</p>}
    <div className="timing-grid">
      <div className="cross-card">
        <h3>זמן לפי שלב (חציון)</h3>
        <table className="timing-table"><thead><tr><th>שלב</th>{channels.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>
          {stages.map(([stage, label]) => <tr key={stage}><td>{label}</td>{channels.map(([key]) => { const s = data.timing[key].stages[stage]; return <td key={key}>{s.count ? <>{fmtDuration(s.median)}<small>ממוצע {fmtDuration(s.average)} · {fmtNumber(s.count)}</small></> : "—"}</td>; })}</tr>)}
        </tbody></table>
      </div>
      <div className="cross-card">
        <h3>התפלגות משך ההצבעה</h3>
        {channels.map(([key, label]) => <div key={key} className="timing-dist"><b>{label}</b><ul className="share-list">{data.timing[key].distribution.map((bucket) => <li key={bucket.label}><span>{bucket.label}</span><Bar share={bucket.share} tone={key === "all" ? undefined : key} /><strong>{bucket.share}% <small>({fmtNumber(bucket.count)})</small></strong></li>)}</ul></div>)}
      </div>
      <div className="cross-card">
        <h3>בכמה ביקורים או שיחות הושלמה ההצבעה</h3>
        {channels.map(([key, label]) => <div key={key} className="timing-dist"><b>{label}</b><ul className="share-list">{data.timing[key].sessions.map((bucket) => <li key={bucket.label}><span>{bucket.label}</span><Bar share={bucket.share} tone={key === "all" ? undefined : key} /><strong>{bucket.share}% <small>({fmtNumber(bucket.count)})</small></strong></li>)}</ul></div>)}
      </div>
    </div>
  </div>;
}

function DailyChart({ data, percentOnly }: { data: Analytics; percentOnly: boolean }) {
  const series = data.daily.series;
  const max = Math.max(1, ...series.map((point) => point.total));
  if (!series.length) return <p className="analytics-empty">עדיין אין הצבעות.</p>;
  const days = series.length ? Math.round((series[series.length - 1].bucket - series[0].bucket) / 86400) + 1 : 0;
  const total = data.totals.ballots;
  return <div className="daily">
    <p className="analytics-note">{fmtNumber(days)} ימים מאז ההצבעה הראשונה · ממוצע {percentOnly ? `${pct(total / Math.max(1, days), total)}%` : fmtNumber(Math.round(total / Math.max(1, days)))} ליום{data.daily.peak ? ` · יום השיא ${fmtDate(data.daily.peak.bucket)} עם ${percentOnly ? `${pct(data.daily.peak.total, total)}%` : fmtNumber(data.daily.peak.total)}` : ""}</p>
    <div className="daily-chart" role="img" aria-label="הצבעות לפי יום">{series.map((point) => <div key={point.bucket} className="daily-col" title={`${fmtDate(point.bucket)}: ${point.total} (אתר ${point.site}, טלפון ${point.phone}) · מצטבר ${point.cumulative}`}><div className="daily-stack" style={{ height: `${(point.total / max) * 100}%` }}><i className="site" style={{ flex: point.site }} /><i className="phone" style={{ flex: point.phone }} /></div><small>{fmtDate(point.bucket)}</small></div>)}</div>
    <div className="daily-legend"><span><i className="site" /> אתר</span><span><i className="phone" /> טלפון</span></div>
    <div className="gaps-table-wrap"><table className="gaps-table daily-table"><thead><tr><th>יום</th><th>אתר</th><th>טלפון</th><th>סה״כ</th><th>מצטבר</th></tr></thead><tbody>{[...series].reverse().map((point) => <tr key={point.bucket}><td>{fmtDate(point.bucket)}</td><td>{percentOnly ? `${pct(point.site, total)}%` : fmtNumber(point.site)}</td><td>{percentOnly ? `${pct(point.phone, total)}%` : fmtNumber(point.phone)}</td><td>{percentOnly ? `${pct(point.total, total)}%` : fmtNumber(point.total)}</td><td>{percentOnly ? `${pct(point.cumulative, total)}%` : fmtNumber(point.cumulative)}</td></tr>)}</tbody></table></div>
  </div>;
}

function OpsSection({ data }: { data: Analytics }) {
  return <div className="timing-grid ops-grid">
    <div className="cross-card">
      <h3>מחשבים חסומים <small>({data.blocked.length})</small></h3>
      {data.blocked.length ? <ul className="ops-list">{data.blocked.map((item) => <li key={item.fingerprint}><b>{item.fingerprint.slice(0, 12)}…</b><small>נחסם {fmtDateTime(item.createdAt)} על ידי {item.blockedBy} · {fmtNumber(item.ballots)} פתקים מהמחשב הזה{item.lastBallotAt ? ` · אחרון ${fmtDateTime(item.lastBallotAt)}` : ""}</small></li>)}</ul> : <p className="analytics-empty">אין מחשבים חסומים בסקר הזה.</p>}
      <p className="analytics-note">ניסיונות הצבעה שנחסמו אינם נשמרים כפתקים, ולכן נספר כאן רק מה שכבר נכנס לפני החסימה.</p>
    </div>
    <div className="cross-card">
      <h3>יומן הניהול בקו <small>({fmtNumber(data.audit.last30Days.total)} פעולות ב-30 יום, {fmtNumber(data.audit.last30Days.failed)} נכשלו)</small></h3>
      {data.audit.recent.length ? <ul className="ops-list">{data.audit.recent.map((row) => <li key={row.id} className={row.status >= 400 ? "failed" : ""}><b>{row.action}{row.target ? ` · ${row.target}` : ""}</b><small>{row.phone} · {fmtDateTime(row.createdAt)} · {row.status >= 400 ? `נכשל (${row.status})` : "הצליח"}</small></li>)}</ul> : <p className="analytics-empty">עדיין אין פעולות ניהול מהקו.</p>}
    </div>
  </div>;
}

function ContentSection({ data }: { data: Analytics }) {
  const groups: Array<[string, Array<{ id: string; title: string; subtitle?: string }>]> = [
    ["שירים בלי קובץ שמע", data.content.songsWithoutAudio],
    ["שירים בלי קטע השמעה", data.content.songsWithoutPreview],
    ["אלבומים בלי עטיפה", data.content.albumsWithoutCover],
    ["זמרים בלי תמונה", data.content.artistsWithoutImage],
    ["קריינויות חסרות לקו", data.content.missingPrompts],
  ];
  return <div className="content-status">
    <div className="analytics-stats">{groups.map(([label, list]) => <article key={label} className={list.length ? "warn" : "ok"}><small>{label}</small><b>{fmtNumber(list.length)}</b></article>)}<article><small>מוסתרים</small><b>{fmtNumber(data.content.inactive.albums + data.content.inactive.songs + data.content.inactive.artists)}</b><span>{data.content.inactive.albums} אלבומים · {data.content.inactive.songs} שירים · {data.content.inactive.artists} זמרים</span></article></div>
    <div className="zero-votes-groups">{groups.filter(([, list]) => list.length).map(([label, list]) => <div key={label}><b>{label}</b><ul>{list.slice(0, 40).map((item) => <li key={item.id}>{item.title}{item.subtitle ? <small> · {item.subtitle}</small> : null}</li>)}{list.length > 40 && <li><small>ועוד {fmtNumber(list.length - 40)}…</small></li>}</ul></div>)}</div>
    {groups.every(([, list]) => !list.length) && <p className="analytics-empty">התוכן שלם: לכל השירים יש שמע וקטע השמעה, לכל האלבומים עטיפה, לכל הזמרים תמונה, ולכולם קריינות.</p>}
  </div>;
}

/** מסך שידור: תצוגה גדולה ונקייה למקרן, מתרעננת לבד כל 20 שניות. */
function BroadcastScreen({ initial, percentOnly, onClose }: { initial: Analytics; percentOnly: boolean; onClose(): void }) {
  const [data, setData] = useState(initial);
  const [kind, setKind] = useState<Kind>("albums");
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    const tick = () => fetch("/api/admin/analytics", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((body) => { if (body) setData(body as Analytics); }).catch(() => undefined);
    const refresh = window.setInterval(tick, 20_000);
    const rotate = window.setInterval(() => { if (auto) setKind((current) => current === "albums" ? "songs" : current === "songs" ? "artists" : "albums"); }, 15_000);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { window.clearInterval(refresh); window.clearInterval(rotate); document.removeEventListener("keydown", onKey); };
  }, [auto, onClose]);
  const list = useMemo(() => data.rankings[kind].slice(0, 10), [data, kind]);
  const max = Math.max(1, ...list.map((item) => item.votes));
  return <div className="broadcast" dir="rtl">
    <header>
      <div><p className="kicker">ראש בראש · תוצאות חיות</p><h1>{KIND_LABEL[kind]}</h1></div>
      <div className="broadcast-controls">
        {(Object.keys(KIND_LABEL) as Kind[]).map((key) => <button key={key} type="button" className={key === kind ? "active" : ""} onClick={() => { setKind(key); setAuto(false); }}>{KIND_LABEL[key]}</button>)}
        <button type="button" className={auto ? "active" : ""} onClick={() => setAuto(!auto)}>{auto ? "מתחלף לבד" : "קבוע"}</button>
        <button type="button" onClick={() => { const root = document.documentElement; if (document.fullscreenElement) void document.exitFullscreen(); else void root.requestFullscreen?.(); }}>מסך מלא</button>
        <button type="button" onClick={onClose}>סגירה</button>
      </div>
    </header>
    <ol className="broadcast-list">{list.map((item: RankedItem) => <li key={item.id} style={{ "--fill": `${(item.votes / max) * 100}%` } as React.CSSProperties}><b>{item.place}</b><span>{item.title}{item.subtitle ? <small>{item.subtitle}</small> : null}</span><strong>{percentOnly ? `${item.share}%` : fmtNumber(item.votes)}</strong></li>)}</ol>
    <footer>{percentOnly ? "" : `${fmtNumber(data.totals.ballots)} הצבעות · `}עודכן {new Date(data.generatedAt * 1000).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</footer>
  </div>;
}

function buildSheets(data: Analytics): TableSheet[] {
  const ranking = (kind: Kind): TableSheet => ({ name: `דירוג ${KIND_LABEL[kind]}`, columns: ["מקום", KIND_LABEL[kind], "פירוט", "קולות", "אחוז מהפתקים", "אתר", "טלפון", "מקום באתר", "מקום בטלפון", "חסר לעלות מקום", "יתרון על הבא"], rows: data.rankings[kind].map((item) => [item.place, item.title, item.subtitle || "", item.votes, item.share, item.site, item.phone, item.sitePlace, item.phonePlace, item.gapAbove === null ? "" : item.gapAbove + 1, item.gapBelow ?? ""]) });
  const stageLabel = { albums: "בחירת אלבומים", songs: "בחירת שירים", artists: "בחירת זמרים", summary: "אישור ושליחה" } as const;
  const timingRows: TableSheet["rows"] = [];
  for (const [key, label] of [["all", "כולם"], ["site", "אתר"], ["phone", "טלפון"]] as const) {
    const t = data.timing[key];
    timingRows.push([label, "כל ההצבעה", t.overall.count, t.overall.median, t.overall.average, t.overall.total]);
    for (const stage of ["albums", "songs", "artists", "summary"] as const) { const s = t.stages[stage]; timingRows.push([label, stageLabel[stage], s.count, s.median, s.average, s.total]); }
  }
  return [
    ranking("albums"), ranking("songs"), ranking("artists"),
    { name: "שירים לפי אלבום", columns: ["אלבום", "אמן", "קולות לאלבום", "שיר", "קולות לשיר", "אחוז מקולות השירים באלבום", "שיר מוביל"], rows: data.albumBreakdown.flatMap((album) => album.songs.length ? album.songs.map((song) => [album.title, album.artistName, album.votes, song.title, song.votes, song.share, album.topSong?.id === song.id ? "כן" : ""]) : [[album.title, album.artistName, album.votes, "", 0, 0, ""]]) },
    { name: "בלי קולות", columns: ["סוג", "שם", "פירוט", "מוסתר"], rows: [...data.zeroVotes.albums.map((item) => ["אלבום", item.title, item.subtitle || "", item.active ? "" : "כן"]), ...data.zeroVotes.songs.map((item) => ["שיר", item.title, item.subtitle || "", item.active ? "" : "כן"]), ...data.zeroVotes.artists.map((item) => ["זמר", item.title, "", item.active ? "" : "כן"])] },
    { name: "זמר-אלבום", columns: ["זמר", "קולות לזמר", "אלבום", "בחרו את שניהם", "אחוז ממצביעי הזמר", "האלבום שלו"], rows: data.artistAlbums.flatMap((artist) => [...artist.top.map((item) => [artist.name, artist.votes, item.title, item.votes, item.share, ""]), ...artist.own.map((item) => [artist.name, artist.votes, item.title, item.both, item.ofArtistVoters, "כן"])]) },
    { name: "אלבומים יחד", columns: ["אלבום", "קולות", "נבחר יחד עם", "פתקים משותפים", "אחוז ממצביעי האלבום"], rows: data.albumCompanions.flatMap((album) => album.top.map((item) => [album.title, album.votes, item.title, item.votes, item.share])) },
    { name: "צמדי זמרים", columns: ["זמר א", "זמר ב", "פתקים משותפים", "אחוז ממצביעי א", "אחוז ממצביעי ב"], rows: data.artistPairs.map((pair) => [pair.a, pair.b, pair.votes, pair.shareOfA, pair.shareOfB]) },
    { name: "חמישיות", columns: ["שילוב", "פתקים", "אחוז מהפתקים"], rows: data.combos.top.map((combo) => [combo.albums.join(" · "), combo.votes, combo.share]) },
    { name: "זמן הצבעה", columns: ["ערוץ", "שלב", "פתקים", "חציון (שניות)", "ממוצע (שניות)", "סה״כ (שניות)"], rows: timingRows },
    { name: "לפי יום", columns: ["יום", "אתר", "טלפון", "סה״כ", "מצטבר"], rows: data.daily.series.map((point) => [new Date(point.bucket * 1000).toLocaleDateString("he-IL"), point.site, point.phone, point.total, point.cumulative]) },
    { name: "חסימות", columns: ["טביעת אצבע", "נחסם על ידי", "תאריך", "פתקים"], rows: data.blocked.map((item) => [item.fingerprint, item.blockedBy, fmtDateTime(item.createdAt), item.ballots]) },
    { name: "יומן הקו", columns: ["תאריך", "טלפון", "פעולה", "יעד", "סטטוס"], rows: data.audit.recent.map((row) => [fmtDateTime(row.createdAt), row.phone, row.action, row.target || "", row.status]) },
    { name: "מצב התוכן", columns: ["בעיה", "פריט", "פירוט"], rows: [...data.content.songsWithoutAudio.map((item) => ["שיר בלי שמע", item.title, item.subtitle || ""]), ...data.content.songsWithoutPreview.map((item) => ["שיר בלי קטע השמעה", item.title, item.subtitle || ""]), ...data.content.albumsWithoutCover.map((item) => ["אלבום בלי עטיפה", item.title, item.subtitle || ""]), ...data.content.artistsWithoutImage.map((item) => ["זמר בלי תמונה", item.title, ""]), ...data.content.missingPrompts.map((item) => ["קריינות חסרה", item.title, item.subtitle || ""])] },
  ];
}
