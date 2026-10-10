/* ההודעות הקופצות של אתר התוכניות — כללים משותפים לשרת ולדף הניהול.

   כל הודעה: סוג התצוגה (חלון במרכז, מגירה מלמטה, הודעה בפינה, פס צף למעלה), צבע, סמל,
   כותרת, טקסט, תמונה, עד שני כפתורים, מועד התחלה וסיום (שעון ישראל), באילו דפים, למי
   (כולם / מחוברים / לא מחוברים, חדשים / חוזרים), כמה פעמים (פעם אחת, פעם בביקור, פעם ביום,
   בכל דף), מתי לקפוץ (אחרי כמה שניות, אחרי גלילה, כשעומדים לצאת) וסגירה אוטומטית.
   הסדר ברשימה הוא סדר העדיפות. `rev` עולה כשהמנהל בוחר "להציג שוב לכולם".
   נשמר ב־settings.popups ומתפרסם עם הקטלוג; לציבור — רק הפעילות שלא עבר זמנן. */

export const POPUP_LIMITS = { popups: 30, name: 80, title: 120, text: 1500, icon: 8, url: 500, label: 40, buttons: 2, delay: 600, autoClose: 120, scroll: 100 };
export const POPUP_KINDS = ["modal", "sheet", "toast", "bar"];
export const POPUP_TONES = ["gold", "violet", "teal", "success", "danger", "night"];
export const POPUP_PAGES = ["home", "archive", "episode", "me", "updates", "other"];
const AUDIENCE = ["all", "signed", "guest"];
const VISITORS = ["all", "new", "returning"];
const FREQ = ["once", "session", "daily", "always"];
const TRIGGERS = ["delay", "scroll", "exit"];

const clean = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const oneLine = (value, max) => clean(value, max).replace(/\s+/g, " ");
const pick = (value, list) => (list.includes(value) ? value : list[0]);
const int = (value, max) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
const wall = (value) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(value || "")) ? String(value).slice(0, 16) : /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? `${value}T00:00` : "");
/** קישור מכפתור: http(s), mailto:, tel: או נתיב באתר. javascript: וכדומה נזרקים. */
export function safePopupUrl(value) {
  const url = oneLine(value, POPUP_LIMITS.url);
  if (!url) return "";
  if (/^(https?:\/\/|mailto:|tel:)[^\s]+$/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return "";
  return /^[\w./?#&=%~+-][^\s]*$/u.test(url) ? url : "";
}

export function normalizePopup(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (!id) return null;
  const image = oneLine(raw.image, POPUP_LIMITS.url);
  const pages = (Array.isArray(raw.pages) ? raw.pages : []).filter((p) => POPUP_PAGES.includes(p));
  const buttons = (Array.isArray(raw.buttons) ? raw.buttons : []).flatMap((b) => {
    const label = oneLine(b?.label, POPUP_LIMITS.label);
    const url = safePopupUrl(b?.url);
    return label ? [{ label, url, style: b?.style === "ghost" ? "ghost" : "primary", newTab: !!b?.newTab }] : [];
  }).slice(0, POPUP_LIMITS.buttons);
  return {
    id,
    enabled: !!raw.enabled,
    name: oneLine(raw.name, POPUP_LIMITS.name),
    kind: pick(raw.kind, POPUP_KINDS),
    tone: pick(raw.tone, POPUP_TONES),
    icon: oneLine(raw.icon, POPUP_LIMITS.icon),
    title: oneLine(raw.title, POPUP_LIMITS.title),
    text: clean(raw.text, POPUP_LIMITS.text),
    image: /^https:\/\/[^\s]+$/i.test(image) ? image : "",
    buttons,
    from: wall(raw.from),
    until: wall(raw.until),
    pages: [...new Set(pages)],
    audience: pick(raw.audience, AUDIENCE),
    visitors: pick(raw.visitors, VISITORS),
    freq: pick(raw.freq, FREQ),
    trigger: pick(raw.trigger, TRIGGERS),
    delay: int(raw.delay, POPUP_LIMITS.delay),
    scroll: int(raw.scroll ?? 50, POPUP_LIMITS.scroll) || 50,
    autoClose: int(raw.autoClose, POPUP_LIMITS.autoClose),
    rev: int(raw.rev, 1e6),
    createdAt: oneLine(raw.createdAt, 40),
  };
}

/** הרשימה כפי שהיא נשמרת: בלי כפולים, עד POPUP_LIMITS.popups. */
export function normalizePopups(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const p = normalizePopup(item);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= POPUP_LIMITS.popups) break;
  }
  return out;
}

/** מה שהציבור מקבל: רק הודעות פעילות, עם תוכן, שמועד הסיום שלהן לא עבר. מנהלים (includeHidden) — הכול. */
export function publicPopups(list, includeHidden = false, now = "") {
  if (includeHidden) return list;
  return list.filter((p) => p.enabled && (p.title || p.text || p.image) && (!now || !p.until || p.until > now));
}
