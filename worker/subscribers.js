/**
 * עזרי רשימת התפוצה. הקובץ נטול תלויות ב-Cloudflare כדי שהטסטים
 * יוכלו לייבא אותו ישירות ולבדוק את הניתוח והנרמול בלי מסד נתונים.
 */

// לא ולידציה מלאה לפי RFC — רק סינון של מה שברור שאינו כתובת,
// כדי שרשימה מיובאת לא תתמלא בשורות זבל.
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

export function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * שולף כתובת ושם משורה אחת של קובץ מיובא. תומך בשורה שהיא כתובת
 * בלבד, ב-CSV עם פסיק/נקודה-פסיק/טאב, ובפורמט `שם <כתובת>` של תוכנות דואר.
 * מחזיר null כשאין בשורה כתובת תקינה.
 */
export function parseSubscriberLine(line) {
  const raw = String(line ?? "").trim();
  if (!raw) return null;

  const angled = raw.match(/^(.*?)<([^<>]+)>\s*$/);
  if (angled && isValidEmail(angled[2])) {
    return { email: normalizeEmail(angled[2]), name: normalizeName(angled[1].trim().replace(/^["']|["']$/g, "")) };
  }

  const cells = raw.split(/[,;\t]/).map((cell) => cell.trim().replace(/^["']|["']$/g, ""));
  const emailIndex = cells.findIndex((cell) => isValidEmail(cell));
  if (emailIndex === -1) return null;
  const name = cells.filter((cell, index) => index !== emailIndex && cell && !isValidEmail(cell)).join(" ");
  return { email: normalizeEmail(cells[emailIndex]), name: normalizeName(name) };
}

/**
 * מנתח קובץ או טקסט מודבק לרשימת נמענים ייחודית.
 * כותרת CSV ("email", "מייל" וכדומה) נופלת מאליה כי אין בה כתובת תקינה.
 * מחזיר גם את מספר השורות שלא הכילו כתובת, כדי שנוכל לדווח למנהל.
 */
export function parseSubscriberList(content) {
  const seen = new Map();
  let skipped = 0;
  for (const line of String(content ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseSubscriberLine(line);
    if (!parsed) { skipped += 1; continue; }
    // השורה הראשונה של כל כתובת מנצחת, אבל שם שמופיע רק בשורה מאוחרת
    // עדיף על שם ריק שנקלט קודם.
    const existing = seen.get(parsed.email);
    if (!existing) seen.set(parsed.email, parsed);
    else if (!existing.name && parsed.name) existing.name = parsed.name;
  }
  return { entries: [...seen.values()], skipped };
}
