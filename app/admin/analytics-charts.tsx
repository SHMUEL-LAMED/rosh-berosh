"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./analytics-charts.css";

/**
 * גרפים ללשונית הנתונים המתקדמים. הכול SVG שנכתב ביד — לפרויקט יש ארבע
 * תלויות ריצה בלבד והוא נארז לוורקר, ולכן אין כאן ספריית גרפים.
 *
 * הצבעים אינם נבחרים בעין: הזוג הקטגורי (אתר/טלפון) והרמפה הסדרתית של
 * מפת החום עברו את בדיקות הניגודיות ועיוורון הצבעים, כולל רצפת 3:1 מול
 * רקע לבן — ולכן הזהב כאן כהה מזהב המותג שבכותרות. שום גרף אינו נשען על
 * צבע בלבד: לכל אחד יש מקרא, תווית טקסט או טבלה מקבילה.
 *
 * הציר האופקי של הזמן רץ מימין לשמאל, ככיוון הקריאה בעברית: המוקדם ביותר
 * בימין. SVG אינו מתהפך לבד עם dir, ולכן ההיפוך מחושב מפורשות.
 */

export const CHANNEL_COLOR = { site: "#1699a8", phone: "#b3831f" } as const;
export const CHANNEL_LABEL = { site: "אתר", phone: "טלפון" } as const;
/** רמפה סדרתית בגוון אחד, בהיר→כהה, עם קצה בהיר שנבדל מהרקע. */
export const HEAT_STEPS = ["#cfa94f", "#b38a2c", "#8f6e1e", "#6d5314", "#4b380b"] as const;
const GRID = "#e7e0d2";
const AXIS_INK = "#8b8478";

export type Channel = keyof typeof CHANNEL_COLOR;
export type SeriesPoint = { bucket: number; site: number; phone: number; total: number; cumulative?: number };

const niceTicks = (max: number, count = 4): number[] => {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Math.round(value));
  return ticks;
};
const fmt = (value: number) => Math.round(value).toLocaleString("he-IL");

/** רוחב אמיתי בפיקסלים, כדי שטקסט לא יימתח עם viewBox. */
function useMeasuredWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = () => setWidth(Math.max(240, Math.round(element.clientWidth)));
    apply();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", apply);
      return () => window.removeEventListener("resize", apply);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** טולטיפ אחד לכל הגרפים: עובד בעכבר ובמגע, ונצמד לגבולות המכל. */
function useHover<T>() {
  const [hover, setHover] = useState<{ item: T; x: number; y: number } | null>(null);
  const show = useCallback((item: T, x: number, y: number) => setHover({ item, x, y }), []);
  const hide = useCallback(() => setHover(null), []);
  return { hover, show, hide };
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const clamped = Math.min(Math.max(x, 80), Math.max(80, width - 80));
  return <div className="chart-tip" style={{ left: `${clamped}px`, top: `${Math.max(0, y)}px` }} role="status">{children}</div>;
}

export function ChartLegend({ items }: { items: Array<{ label: string; color: string; note?: string }> }) {
  return <ul className="chart-legend">{items.map((item) => <li key={item.label}><i style={{ background: item.color }} aria-hidden="true" />{item.label}{item.note ? <small>{item.note}</small> : null}</li>)}</ul>;
}

/**
 * קו מצטבר לשני ערוצים. מילוי שטח ברמז בלבד, קו בעובי 2, נקודת קצה
 * מסומנת עם טבעת ברקע, וקו הצלבה שנע עם הסמן.
 */
export function CumulativeChart({ series, label, height = 230, formatValue = fmt }: { series: SeriesPoint[]; label: string; height?: number; formatValue?(value: number): string }) {
  const { ref, width } = useMeasuredWidth();
  const { hover, show, hide } = useHover<{ point: SeriesPoint; siteTotal: number; phoneTotal: number }>();
  const pad = { top: 14, right: 46, bottom: 26, left: 14 };
  const plotWidth = Math.max(10, width - pad.left - pad.right);
  const plotHeight = Math.max(10, height - pad.top - pad.bottom);

  const running = useMemo(() => {
    const rows: Array<{ point: SeriesPoint; siteTotal: number; phoneTotal: number }> = [];
    for (const point of series) {
      const previous = rows[rows.length - 1];
      rows.push({ point, siteTotal: (previous?.siteTotal ?? 0) + point.site, phoneTotal: (previous?.phoneTotal ?? 0) + point.phone });
    }
    return rows;
  }, [series]);
  const max = Math.max(1, ...running.map((row) => row.siteTotal + row.phoneTotal));
  const ticks = niceTicks(max);
  const top = Math.max(max, ticks[ticks.length - 1] || max);
  // מימין לשמאל: המוקדם ביותר בקצה הימני.
  const xAt = (index: number) => pad.left + plotWidth - (running.length < 2 ? plotWidth / 2 : (index / (running.length - 1)) * plotWidth);
  const yAt = (value: number) => pad.top + plotHeight - (value / top) * plotHeight;

  const path = (pick: (row: typeof running[number]) => number) => running.map((row, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(pick(row)).toFixed(1)}`).join(" ");
  const areaPath = (pick: (row: typeof running[number]) => number) => running.length ? `${path(pick)} L${xAt(running.length - 1).toFixed(1)},${(pad.top + plotHeight).toFixed(1)} L${xAt(0).toFixed(1)},${(pad.top + plotHeight).toFixed(1)} Z` : "";

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!running.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const ratio = running.length < 2 ? 0 : (pad.left + plotWidth - x) / plotWidth;
    const index = Math.min(running.length - 1, Math.max(0, Math.round(ratio * (running.length - 1))));
    show(running[index], xAt(index), yAt(running[index].siteTotal + running[index].phoneTotal) - 8);
  };

  const summary = running.length ? `${label}: ${formatValue(running[running.length - 1].siteTotal + running[running.length - 1].phoneTotal)} בסך הכול על פני ${running.length} ימים.` : label;
  return <div className="chart" ref={ref} style={{ height }}>
    <svg width={width} height={height} role="img" aria-label={summary} onPointerMove={onMove} onPointerLeave={hide} onPointerDown={onMove}>
      {ticks.map((tick) => <g key={tick}>
        <line x1={pad.left} x2={pad.left + plotWidth} y1={yAt(tick)} y2={yAt(tick)} stroke={GRID} strokeWidth={1} />
        <text x={pad.left + plotWidth + 6} y={yAt(tick) + 4} fill={AXIS_INK} fontSize={11} textAnchor="start">{formatValue(tick)}</text>
      </g>)}
      {running.length > 1 && <>
        <path d={areaPath((row) => row.siteTotal + row.phoneTotal)} fill={CHANNEL_COLOR.phone} fillOpacity={0.1} />
        <path d={areaPath((row) => row.siteTotal)} fill={CHANNEL_COLOR.site} fillOpacity={0.1} />
      </>}
      <path d={path((row) => row.siteTotal + row.phoneTotal)} fill="none" stroke={CHANNEL_COLOR.phone} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <path d={path((row) => row.siteTotal)} fill="none" stroke={CHANNEL_COLOR.site} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {running.length > 0 && [{ pick: (row: typeof running[number]) => row.siteTotal + row.phoneTotal, color: CHANNEL_COLOR.phone }, { pick: (row: typeof running[number]) => row.siteTotal, color: CHANNEL_COLOR.site }].map((line, index) =>
        <circle key={index} cx={xAt(running.length - 1)} cy={yAt(line.pick(running[running.length - 1]))} r={4.5} fill={line.color} stroke="#fff" strokeWidth={2} />)}
      {hover && <line x1={hover.x} x2={hover.x} y1={pad.top} y2={pad.top + plotHeight} stroke={AXIS_INK} strokeWidth={1} strokeOpacity={0.45} />}
      {running.length > 0 && <text x={xAt(0)} y={height - 8} fill={AXIS_INK} fontSize={11} textAnchor="end">{dayLabel(running[0].point.bucket)}</text>}
      {running.length > 1 && <text x={xAt(running.length - 1)} y={height - 8} fill={AXIS_INK} fontSize={11} textAnchor="start">{dayLabel(running[running.length - 1].point.bucket)}</text>}
    </svg>
    {hover && <Tooltip x={hover.x} y={hover.y} width={width}>
      <b>{dayLabel(hover.item.point.bucket)}</b>
      <span><i style={{ background: CHANNEL_COLOR.site }} aria-hidden="true" />{CHANNEL_LABEL.site} {formatValue(hover.item.siteTotal)}</span>
      <span><i style={{ background: CHANNEL_COLOR.phone }} aria-hidden="true" />{CHANNEL_LABEL.phone} {formatValue(hover.item.phoneTotal)}</span>
      <span><b>סה״כ {formatValue(hover.item.siteTotal + hover.item.phoneTotal)}</b></span>
    </Tooltip>}
  </div>;
}

/** עמודות מוערמות ליום, עם רווח של 2 פיקסלים בצבע הרקע בין המקטעים. */
export function DailyColumns({ series, height = 200, formatValue = fmt }: { series: SeriesPoint[]; height?: number; formatValue?(value: number): string }) {
  const { ref, width } = useMeasuredWidth();
  const { hover, show, hide } = useHover<SeriesPoint>();
  const pad = { top: 12, right: 46, bottom: 26, left: 10 };
  const plotWidth = Math.max(10, width - pad.left - pad.right);
  const plotHeight = Math.max(10, height - pad.top - pad.bottom);
  const max = Math.max(1, ...series.map((point) => point.total));
  const ticks = niceTicks(max);
  const top = Math.max(max, ticks[ticks.length - 1] || max);
  const band = series.length ? plotWidth / series.length : plotWidth;
  const barWidth = Math.max(2, Math.min(24, band - 3));
  const xAt = (index: number) => pad.left + plotWidth - (index + 0.5) * band - barWidth / 2;
  const scale = (value: number) => (value / top) * plotHeight;

  const summary = `הצבעות לפי יום: ${series.length} ימים, שיא של ${formatValue(max)} ביום אחד.`;
  return <div className="chart" ref={ref} style={{ height }}>
    <svg width={width} height={height} role="img" aria-label={summary} onPointerLeave={hide}>
      {ticks.map((tick) => <g key={tick}>
        <line x1={pad.left} x2={pad.left + plotWidth} y1={pad.top + plotHeight - scale(tick)} y2={pad.top + plotHeight - scale(tick)} stroke={GRID} strokeWidth={1} />
        <text x={pad.left + plotWidth + 6} y={pad.top + plotHeight - scale(tick) + 4} fill={AXIS_INK} fontSize={11} textAnchor="start">{formatValue(tick)}</text>
      </g>)}
      {series.map((point, index) => {
        const siteHeight = scale(point.site), phoneHeight = scale(point.phone);
        const x = xAt(index);
        const baseline = pad.top + plotHeight;
        // הרווח בצבע הרקע הוא שמפריד בין המקטעים — לא מסגרת סביבם.
        const gap = point.site > 0 && point.phone > 0 ? 2 : 0;
        return <g key={point.bucket} onPointerEnter={() => show(point, x + barWidth / 2, Math.max(0, baseline - siteHeight - phoneHeight - 10))} onPointerDown={() => show(point, x + barWidth / 2, Math.max(0, baseline - siteHeight - phoneHeight - 10))}>
          <rect x={x - 1.5} y={pad.top} width={barWidth + 3} height={plotHeight} fill="transparent" />
          {point.site > 0 && <rect x={x} y={baseline - siteHeight} width={barWidth} height={siteHeight} fill={CHANNEL_COLOR.site} rx={phoneHeight ? 0 : Math.min(4, barWidth / 2)} />}
          {point.phone > 0 && <rect x={x} y={baseline - siteHeight - gap - phoneHeight} width={barWidth} height={phoneHeight} fill={CHANNEL_COLOR.phone} rx={Math.min(4, barWidth / 2)} />}
        </g>;
      })}
      <line x1={pad.left} x2={pad.left + plotWidth} y1={pad.top + plotHeight} y2={pad.top + plotHeight} stroke={GRID} strokeWidth={1} />
      {series.length > 0 && <text x={pad.left + plotWidth} y={height - 8} fill={AXIS_INK} fontSize={11} textAnchor="end">{dayLabel(series[0].bucket)}</text>}
      {series.length > 1 && <text x={pad.left} y={height - 8} fill={AXIS_INK} fontSize={11} textAnchor="start">{dayLabel(series[series.length - 1].bucket)}</text>}
    </svg>
    {hover && <Tooltip x={hover.x} y={hover.y} width={width}>
      <b>{dayLabel(hover.item.bucket)}</b>
      <span><i style={{ background: CHANNEL_COLOR.site }} aria-hidden="true" />{CHANNEL_LABEL.site} {formatValue(hover.item.site)}</span>
      <span><i style={{ background: CHANNEL_COLOR.phone }} aria-hidden="true" />{CHANNEL_LABEL.phone} {formatValue(hover.item.phone)}</span>
      <span><b>סה״כ {formatValue(hover.item.total)}</b></span>
    </Tooltip>}
  </div>;
}

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const WEEKDAY_SHORT = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

/** מפת חום יום-בשבוע על שעה, בגוון אחד עם מקרא ורמת ערך בכל תא. */
export function ActivityHeatmap({ cells, formatValue = fmt }: { cells: number[][]; formatValue?(value: number): string }) {
  const { ref, width } = useMeasuredWidth();
  const { hover, show, hide } = useHover<{ weekday: number; hour: number; value: number }>();
  const labelWidth = 26, rowGap = 2;
  const cellWidth = Math.max(6, (width - labelWidth - 2) / 24);
  const cellHeight = Math.max(12, Math.min(22, cellWidth));
  const height = 7 * (cellHeight + rowGap) + 20;
  const max = Math.max(1, ...cells.flat());
  // שורש ריכוך: בלעדיו כמעט כל התאים נופלים למדרגה הבהירה ביותר כשיש שיא בודד.
  const stepOf = (value: number) => (value <= 0 ? -1 : Math.min(HEAT_STEPS.length - 1, Math.max(0, Math.ceil(((value / max) ** 0.65) * HEAT_STEPS.length) - 1)));
  const busiest = useMemo(() => {
    let best = { weekday: 0, hour: 0, value: 0 };
    cells.forEach((row, weekday) => row.forEach((value, hour) => { if (value > best.value) best = { weekday, hour, value }; }));
    return best;
  }, [cells]);

  return <div className="chart heatmap" ref={ref} style={{ height }}>
    <svg width={width} height={height} role="img" aria-label={`מפת פעילות לפי יום ושעה. השיא ביום ${WEEKDAYS[busiest.weekday]} בשעה ${busiest.hour}:00 עם ${formatValue(busiest.value)} הצבעות.`} onPointerLeave={hide}>
      {cells.map((row, weekday) => <g key={weekday}>
        <text x={width - 3} y={weekday * (cellHeight + rowGap) + cellHeight * 0.72} fill={AXIS_INK} fontSize={11} textAnchor="end">{WEEKDAY_SHORT[weekday]}</text>
        {row.map((value, hour) => {
          const step = stepOf(value);
          // הציר רץ מימין לשמאל: שעה 0 בימין.
          const x = width - labelWidth - (hour + 1) * cellWidth;
          const y = weekday * (cellHeight + rowGap);
          return <rect key={hour} x={x} y={y} width={Math.max(1, cellWidth - rowGap)} height={cellHeight} rx={3}
            fill={step < 0 ? "#f3efe6" : HEAT_STEPS[step]}
            onPointerEnter={() => show({ weekday, hour, value }, x + cellWidth / 2, Math.max(0, y - 6))}
            onPointerDown={() => show({ weekday, hour, value }, x + cellWidth / 2, Math.max(0, y - 6))} />;
        })}
      </g>)}
      {[0, 6, 12, 18, 23].map((hour) => <text key={hour} x={width - labelWidth - (hour + 0.5) * cellWidth} y={height - 5} fill={AXIS_INK} fontSize={10} textAnchor="middle">{hour}</text>)}
    </svg>
    {hover && <Tooltip x={hover.x} y={hover.y} width={width}>
      <b>{WEEKDAYS[hover.item.weekday]} {String(hover.item.hour).padStart(2, "0")}:00</b>
      <span>{formatValue(hover.item.value)} הצבעות</span>
    </Tooltip>}
  </div>;
}

export function HeatLegend({ max, formatValue = fmt }: { max: number; formatValue?(value: number): string }) {
  return <div className="heat-legend"><span>אין</span><i style={{ background: "#f3efe6" }} aria-hidden="true" />{HEAT_STEPS.map((color) => <i key={color} style={{ background: color }} aria-hidden="true" />)}<span>{formatValue(max)}</span></div>;
}

/** חלוקה בין שני ערוצים כעמודה אחת מפוצלת — לא עוגה בשתי פרוסות. */
export function ChannelSplit({ site, phone, formatValue = fmt }: { site: number; phone: number; formatValue?(value: number): string }) {
  const total = Math.max(1, site + phone);
  const sitePercent = Math.round((site / total) * 1000) / 10;
  return <div className="split-bar" role="img" aria-label={`אתר ${formatValue(site)}, טלפון ${formatValue(phone)}.`}>
    <div className="split-track">
      <span style={{ width: `${sitePercent}%`, background: CHANNEL_COLOR.site }} />
      <span style={{ width: `${Math.round((phone / total) * 1000) / 10}%`, background: CHANNEL_COLOR.phone }} />
    </div>
    <div className="split-labels"><b style={{ color: "#0f7a86" }}>{CHANNEL_LABEL.site} {sitePercent}%</b><b style={{ color: "#8a6318" }}>{CHANNEL_LABEL.phone} {Math.round((phone / total) * 1000) / 10}%</b></div>
  </div>;
}

/** קו זעיר לשורת טבלה. ללא צירים וללא טולטיפ — הטבלה נושאת את המספרים. */
export function Sparkline({ values, color = CHANNEL_COLOR.site, width = 86, height = 22, title }: { values: number[]; color?: string; width?: number; height?: number; title?: string }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const max = Math.max(1, ...values), min = Math.min(...values);
  const span = Math.max(1, max - min);
  const points = values.map((value, index) => {
    const x = width - (index / (values.length - 1)) * (width - 2) - 1;
    const y = height - 2 - ((value - min) / span) * (height - 4);
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg width={width} height={height} role="img" aria-label={title || "מגמה"}>
    <path d={points} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** רשימת דירוג עם פסים. מציגה חלון ומרחיבה לפי בקשה, כדי ש-600 שירים לא יקרסו. */
export function RankBars({ items, initial = 12, formatValue = fmt, emphasise }: { items: Array<{ id: string; title: string; subtitle?: string; value: number; display?: string }>; initial?: number; formatValue?(value: number): string; emphasise?: string }) {
  // אין איפוס באפקט: החלון נחתך לאורך הרשימה בזמן הרינדור, כך שהחלפת
  // הקטגוריה אינה גוררת רינדור נוסף ואינה מציגה שורות שאינן קיימות.
  const [shown, setShown] = useState(initial);
  const max = Math.max(1, ...items.map((item) => item.value));
  const window = Math.min(Math.max(initial, shown), Math.max(initial, items.length));
  const visible = items.slice(0, window);
  if (!items.length) return <p className="analytics-empty">אין נתונים להצגה.</p>;
  return <div className="rank-bars">
    {visible.map((item, index) => <div key={item.id} className={item.id === emphasise ? "on" : ""}>
      <b>{index + 1}</b>
      <span>{item.title}{item.subtitle ? <small>{item.subtitle}</small> : null}</span>
      <i className="rank-track"><i style={{ width: `${Math.max(1, (item.value / max) * 100)}%` }} /></i>
      <strong>{item.display ?? formatValue(item.value)}</strong>
    </div>)}
    {window < items.length && <button type="button" className="analytics-button" onClick={() => setShown(window + 40)}>הצגת עוד {Math.min(40, items.length - window)} מתוך {formatValue(items.length - window)}</button>}
    {window > initial && <button type="button" className="analytics-button" onClick={() => setShown(initial)}>הצגה מצומצמת</button>}
  </div>;
}

/** צבעים קטגוריים למרוץ הדירוג, בסדר קבוע. כל קו נושא גם תווית בקצה. */
export const RACE_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"] as const;

export type RaceLine = { id: string; title: string; points: Array<{ bucket: number; cumulative: number }> };

/** מרוץ הדירוג: קו מצטבר לכל פריט מוביל, עם תווית ישירה בקצה הקו. */
export function RaceChart({ lines, height = 240, formatValue = fmt }: { lines: RaceLine[]; height?: number; formatValue?(value: number): string }) {
  const { ref, width } = useMeasuredWidth();
  const { hover, show, hide } = useHover<{ bucket: number; values: Array<{ title: string; color: string; value: number }> }>();
  const pad = { top: 14, right: 52, bottom: 26, left: 92 };
  const plotWidth = Math.max(10, width - pad.left - pad.right);
  const plotHeight = Math.max(10, height - pad.top - pad.bottom);
  const days = lines[0]?.points.length ?? 0;
  const max = Math.max(1, ...lines.flatMap((line) => line.points.map((point) => point.cumulative)));
  const ticks = niceTicks(max);
  const top = Math.max(max, ticks[ticks.length - 1] || max);
  const xAt = (index: number) => pad.left + plotWidth - (days < 2 ? plotWidth / 2 : (index / (days - 1)) * plotWidth);
  const yAt = (value: number) => pad.top + plotHeight - (value / top) * plotHeight;

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!days) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = days < 2 ? 0 : (pad.left + plotWidth - (event.clientX - box.left)) / plotWidth;
    const index = Math.min(days - 1, Math.max(0, Math.round(ratio * (days - 1))));
    show({ bucket: lines[0].points[index].bucket, values: lines.map((line, order) => ({ title: line.title, color: RACE_COLORS[order % RACE_COLORS.length], value: line.points[index].cumulative })) }, xAt(index), pad.top);
  };

  if (!lines.length || days < 2) return <p className="analytics-empty">צריך לפחות יומיים של הצבעות כדי להראות מרוץ.</p>;
  return <div className="chart" ref={ref} style={{ height }}>
    <svg width={width} height={height} role="img" aria-label={`מרוץ הדירוג בין ${lines.map((line) => line.title).join(", ")}.`} onPointerMove={onMove} onPointerLeave={hide} onPointerDown={onMove}>
      {ticks.map((tick) => <g key={tick}>
        <line x1={pad.left} x2={pad.left + plotWidth} y1={yAt(tick)} y2={yAt(tick)} stroke={GRID} strokeWidth={1} />
        <text x={pad.left + plotWidth + 6} y={yAt(tick) + 4} fill={AXIS_INK} fontSize={11} textAnchor="start">{formatValue(tick)}</text>
      </g>)}
      {hover && <line x1={hover.x} x2={hover.x} y1={pad.top} y2={pad.top + plotHeight} stroke={AXIS_INK} strokeWidth={1} strokeOpacity={0.45} />}
      {lines.map((line, order) => {
        const color = RACE_COLORS[order % RACE_COLORS.length];
        const path = line.points.map((point, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(point.cumulative).toFixed(1)}`).join(" ");
        const endY = yAt(line.points[line.points.length - 1].cumulative);
        return <g key={line.id}>
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={xAt(days - 1)} cy={endY} r={4.5} fill={color} stroke="#fff" strokeWidth={2} />
          {/* תווית ישירה בקצה: הזיהוי אינו נשען על הצבע בלבד. */}
          <text x={pad.left - 8} y={endY + 4} fill={AXIS_INK} fontSize={11} textAnchor="end">{line.title.length > 14 ? `${line.title.slice(0, 13)}…` : line.title}</text>
        </g>;
      })}
      <text x={xAt(0)} y={height - 8} fill={AXIS_INK} fontSize={11} textAnchor="end">{dayLabel(lines[0].points[0].bucket)}</text>
      <text x={xAt(days - 1)} y={height - 8} fill={AXIS_INK} fontSize={11} textAnchor="start">{dayLabel(lines[0].points[days - 1].bucket)}</text>
    </svg>
    {hover && <Tooltip x={hover.x} y={hover.y} width={width}>
      <b>{dayLabel(hover.item.bucket)}</b>
      {hover.item.values.map((value) => <span key={value.title}><i style={{ background: value.color }} aria-hidden="true" />{value.title} {formatValue(value.value)}</span>)}
    </Tooltip>}
  </div>;
}

export function dayLabel(bucketSeconds: number): string {
  return new Date(bucketSeconds * 1000).toLocaleDateString("he-IL", { day: "numeric", month: "short" });
}
