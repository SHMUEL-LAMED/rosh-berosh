/**
 * חישובים סטטיסטיים ללשונית הנתונים המתקדמים. מודול JS טהור בלי תלות
 * ב-D1 או ב-React, כדי שאפשר יהיה לבדוק כל נוסחה בנפרד. כל פונקציה כאן
 * מקבלת מערכים או מספרים ומחזירה מספרים — שום שאילתה ושום I/O.
 */

/** שעון ישראל: +2 בחורף, +3 בקיץ. שעון הקיץ מתחיל בשישי שלפני האחרון במרץ
 * ומסתיים ביום ראשון האחרון של אוקטובר. הפונקציה עובדת על שניות UTC
 * ומחזירה את ההיסט בשניות, כדי שאפשר יהיה לדלות שעה מקומית בלי Intl. */
export function israelOffsetSeconds(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const year = date.getUTCFullYear();
  // תחילת שעון הקיץ: יום שישי שלפני יום ראשון האחרון במרץ, ב-02:00 שעון מקומי (00:00 UTC).
  const lastMarchSunday = lastWeekdayUtc(year, 2, 0);
  const dstStart = Date.UTC(year, 2, lastMarchSunday - 2, 0, 0, 0) / 1000;
  // סיום: יום ראשון האחרון באוקטובר ב-02:00 מקומי (23:00 UTC של השבת שלפניו).
  const lastOctoberSunday = lastWeekdayUtc(year, 9, 0);
  const dstEnd = Date.UTC(year, 9, lastOctoberSunday, 0, 0, 0) / 1000 - 3600;
  return unixSeconds >= dstStart && unixSeconds < dstEnd ? 3 * 3600 : 2 * 3600;
}

function lastWeekdayUtc(year, monthIndex, weekday) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  const shift = (lastDay.getUTCDay() - weekday + 7) % 7;
  return lastDay.getUTCDate() - shift;
}

/** שעה מקומית (0–23) ויום בשבוע (0=ראשון) מתוך חותמת UTC. */
export function israelParts(unixSeconds) {
  const local = new Date((unixSeconds + israelOffsetSeconds(unixSeconds)) * 1000);
  return { hour: local.getUTCHours(), weekday: local.getUTCDay(), dayStart: Math.floor((unixSeconds + israelOffsetSeconds(unixSeconds)) / 86400) * 86400 - israelOffsetSeconds(unixSeconds) };
}

/** אחוזון בשיטת האינטרפולציה הליניארית. `fraction` בין 0 ל-1. */
export function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * Math.min(1, Math.max(0, fraction));
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

/** סיכום התפלגות: כמות, ממוצע, חציון, רבעונים, סך הכול ומינימום/מקסימום. */
export function summarize(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, average: 0, median: 0, p25: 0, p75: 0, p90: 0, min: 0, max: 0, total: 0 };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    average: Math.round(total / sorted.length),
    median: Math.round(percentile(sorted, 0.5)),
    p25: Math.round(percentile(sorted, 0.25)),
    p75: Math.round(percentile(sorted, 0.75)),
    p90: Math.round(percentile(sorted, 0.9)),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    total,
  };
}

/**
 * מדד ריכוזיות הרפינדל־הירשמן, מנורמל ל-0–100. 100 פירושו שכל הקולות
 * הלכו לפריט אחד; ערך נמוך פירושו מרוץ פתוח. הנרמול מתחשב במספר
 * הפריטים, כך שאפשר להשוות בין סקר עם 10 אלבומים לסקר עם 50.
 */
export function concentrationIndex(voteCounts) {
  const counts = voteCounts.filter((value) => Number.isFinite(value) && value > 0);
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!total || counts.length < 2) return counts.length ? 100 : 0;
  const hhi = counts.reduce((sum, value) => sum + (value / total) ** 2, 0);
  const floor = 1 / counts.length;
  return Math.round(Math.max(0, Math.min(1, (hhi - floor) / (1 - floor))) * 1000) / 10;
}

/** מקדם ג'יני על התפלגות הקולות: 0 = כולם שווים, 1 = הכול אצל אחד. */
export function giniCoefficient(voteCounts) {
  const sorted = voteCounts.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (!total || sorted.length < 2) return 0;
  let weighted = 0;
  sorted.forEach((value, index) => { weighted += (index + 1) * value; });
  const gini = (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
  return Math.round(Math.max(0, Math.min(1, gini)) * 1000) / 1000;
}

/** מתאם פירסון בין שני מערכים באותו אורך. מחזיר null כשאין מספיק שונות. */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX / n, meanY = sumY / n;
  let covariance = 0, varianceX = 0, varianceY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    covariance += dx * dy; varianceX += dx * dx; varianceY += dy * dy;
  }
  if (varianceX <= 0 || varianceY <= 0) return null;
  return Math.round((covariance / Math.sqrt(varianceX * varianceY)) * 1000) / 1000;
}

/**
 * תחזית פשוטה לסך ההצבעות בסוף: הקצב של החלון האחרון מוכפל בזמן שנותר,
 * ונוסף למה שכבר יש. מחזירה null כשאין מספיק היסטוריה או כשאין תאריך סיום,
 * כדי שלא נציג מספר שנראה בטוח ואינו.
 */
export function projectTotal({ current, windowVotes, windowSeconds, secondsRemaining }) {
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0) return null;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  if (!Number.isFinite(windowVotes) || windowVotes <= 0) return null;
  const perSecond = windowVotes / windowSeconds;
  return Math.round(current + perSecond * secondsRemaining);
}

/** דירוג תחרותי: תיקו מקבל את אותו מקום, והמקום הבא מדלג. */
export function competitionPlaces(entries, valueOf) {
  const ordered = [...entries].sort((a, b) => valueOf(b) - valueOf(a));
  const places = new Map();
  let place = 0, previous = null;
  ordered.forEach((entry, index) => {
    const value = valueOf(entry);
    if (previous === null || value !== previous) place = index + 1;
    previous = value;
    places.set(entry.id, place);
  });
  return places;
}
