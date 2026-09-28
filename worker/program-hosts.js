/* המגישים של אתר התוכניות — כללים משותפים לשרת ולדף הניהול.

   כל מגיש: שם, שורת תפקיד, כמה מילים, תמונה, קישורים, העונות שהגיש (מזהי העונות בקטלוג —
   מהן נאספות התוכניות שלו), והאם הוא מגיש כיום. הסדר ברשימה הוא הסדר באתר.
   נשמר ב־settings.hosts ומתפרסם עם הקטלוג. עד שנשמרה רשימה — DEFAULT_HOSTS (כמו פרטי הקשר). */

export const HOST_LIMITS = { hosts: 20, name: 80, role: 80, bio: 2000, links: 6, label: 40, url: 500, seasons: 40 };

/** מה שהאתר הציג עד היום בפסקה "מאחורי המיקרופון" — נקודת התחלה לעריכה בניהול */
export const DEFAULT_HOSTS = [
  { name: "קובי בלום", role: "מגיש", bio: "", photo: "", links: [], seasons: ["slater", "levi", "trio"], current: true },
  { name: "ירמי סלייטר", role: "מגיש", bio: "", photo: "https://rosh-berosh.smwlyqswkwt232.workers.dev/api/program/profile-photo/yermi-slater", links: [], seasons: ["slater", "trio"], current: true },
  { name: "מיכאל לוי", role: "מייסד התוכנית", bio: "", photo: "", links: [], seasons: ["levi", "trio"], current: false },
  { name: "ארי וייזר", role: "מגיש בגרסת השלישייה", bio: "", photo: "", links: [], seasons: ["trio"], current: false },
  { name: "חיים וינר", role: "מגיש בגרסת השלישייה", bio: "", photo: "", links: [], seasons: ["trio"], current: false },
  { name: "שלמה גולדברג", role: "מייסד ראש בראש", bio: "", photo: "", links: [], seasons: ["legacy"], current: false },
];

const clean = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const oneLine = (value, max) => clean(value, max).replace(/\s+/g, " ");
const hostKey = (name) => String(name ?? "").replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** הרשימה כפי שהיא נשמרת. לא מערך (עוד לא נשמרה רשימה) — null, והמציגים משתמשים ב־DEFAULT_HOSTS.
    מערך ריק הוא בחירה: "בלי מגישים באתר". */
export function normalizeHosts(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = oneLine(item.name, HOST_LIMITS.name), key = hostKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const photo = oneLine(item.photo, HOST_LIMITS.url);
    const links = (Array.isArray(item.links) ? item.links : []).flatMap((link) => {
      const url = oneLine(link?.url, HOST_LIMITS.url);
      return /^https?:\/\/[^\s]+$/i.test(url) ? [{ label: oneLine(link?.label, HOST_LIMITS.label), url }] : [];
    }).slice(0, HOST_LIMITS.links);
    const seasons = [...new Set((Array.isArray(item.seasons) ? item.seasons : []).map((s) => String(s ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60)).filter(Boolean))].slice(0, HOST_LIMITS.seasons);
    out.push({ name, role: oneLine(item.role, HOST_LIMITS.role), bio: clean(item.bio, HOST_LIMITS.bio), photo: /^https:\/\/[^\s]+$/i.test(photo) ? photo : "", links, seasons, current: item.current !== false });
    if (out.length >= HOST_LIMITS.hosts) break;
  }
  return out;
}

/** מה שמוצג: הרשימה שנשמרה, או ברירת המחדל כשעוד לא נשמרה */
export function publicHosts(raw) {
  return normalizeHosts(raw) ?? DEFAULT_HOSTS.map((host) => ({ ...host, links: [], seasons: [...host.seasons] }));
}
