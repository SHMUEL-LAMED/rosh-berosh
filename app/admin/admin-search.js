/**
 * החיפוש המהיר בניהול (Ctrl+K): התאמה בין מה שהוקלד לשמות של תוכניות, אלבומים, שירים, זמרים וחלקים.
 * כאן, ולא בקובץ הרכיב, כדי שהבדיקות יוכלו להריץ אותו ישירות.
 */

/** @typedef {{ kind: "tab" | "episode" | "album" | "song" | "artist"; id: string; title: string; sub?: string }} SearchItem */

export const KIND_ORDER = ["tab", "episode", "album", "song", "artist"];

/** בלי ניקוד, גרשיים, מקפים ורווחים כפולים — "ראש־בראש" = "ראש בראש", "תשפ״ז" = "תשפז" @param {string} value */
export const normalizeSearch = (value) => String(value ?? "").normalize("NFKD").replace(/[֑-ׇ]/g, (ch) => (ch === "־" ? " " : "")).replace(/["'`׳״]/g, "").replace(/[\-_–—]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * כל המילים שהוקלדו צריכות להופיע (בשם או בשורת המשנה); שם שמתחיל במילה הראשונה קודם, ואז לפי סוג.
 * בלי טקסט — מוצגים חלקי הניהול.
 * @param {SearchItem[]} items @param {string} query @param {number} [limit]
 * @returns {SearchItem[]}
 */
export function searchItems(items, query, limit = 40) {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (!words.length) return items.filter((item) => item.kind === "tab").slice(0, limit);
  const scored = [];
  for (const item of items) {
    const title = normalizeSearch(item.title), hay = `${title} ${normalizeSearch(item.sub || "")}`;
    if (!words.every((word) => hay.includes(word))) continue;
    const score = (title.startsWith(words[0]) ? 0 : title.includes(words[0]) ? 1 : 2) * 10 + KIND_ORDER.indexOf(item.kind);
    scored.push({ item, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.item.title.localeCompare(b.item.title, "he")).slice(0, limit).map((entry) => entry.item);
}
