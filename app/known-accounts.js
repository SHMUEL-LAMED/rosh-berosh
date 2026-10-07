/**
 * החשבונות שכבר נכנסו מהמכשיר הזה — לחלון בחירת החשבון (app/account-chooser.tsx).
 * נשמרים ב־localStorage: כתובת, שם ותמונה בלבד — בלי סשן ובלי טוקן. עד שלושה, האחרון שנכנס
 * ראשון. נזכרים בכל פעם שהשרת מחזיר משתמש מחובר, ונשארים אחרי התנתקות: זו כל המטרה — בביקור
 * הבא בוחרים את החשבון בלחיצה. הפונקציות טהורות כדי שאפשר לבדוק אותן בלי דפדפן
 * (tests/known-accounts.test.mjs).
 */
export const KNOWN_ACCOUNTS_KEY = "rosh-berosh-known-accounts";
export const MAX_KNOWN_ACCOUNTS = 3;

/** @typedef {{ email: string; name: string; picture: string; at: number }} KnownAccount */

/**
 * מנקה רשימה שנקראה מהאחסון: רק רשומות עם כתובת, עד המכסה.
 * @param {unknown} raw
 * @returns {KnownAccount[]}
 */
export function normalizeKnownAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === "object" && typeof a.email === "string" && a.email.includes("@"))
    .map((a) => ({ email: a.email.trim().toLowerCase(), name: typeof a.name === "string" ? a.name : "", picture: typeof a.picture === "string" ? a.picture : "", at: Number(a.at) || 0 }))
    .slice(0, MAX_KNOWN_ACCOUNTS);
}

/**
 * מוסיף את החשבון שנכנס עכשיו לראש הרשימה (או מעלה אותו לראש אם כבר שם). מחזיר רשימה חדשה.
 * @param {unknown} list
 * @param {{ email?: string; name?: string; picture?: string } | null | undefined} user
 * @param {number} [now]
 * @returns {KnownAccount[]}
 */
export function rememberAccount(list, user, now = Date.now()) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email.includes("@")) return normalizeKnownAccounts(list);
  const rest = normalizeKnownAccounts(list).filter((a) => a.email !== email);
  return [{ email, name: String(user?.name || ""), picture: typeof user?.picture === "string" ? user.picture : "", at: now }, ...rest].slice(0, MAX_KNOWN_ACCOUNTS);
}

/**
 * @param {{ getItem(key: string): string | null }} storage
 * @returns {KnownAccount[]}
 */
export function readKnownAccounts(storage) {
  try { return normalizeKnownAccounts(JSON.parse(storage.getItem(KNOWN_ACCOUNTS_KEY) || "[]")); } catch { return []; }
}

/**
 * @param {{ setItem(key: string, value: string): void; removeItem(key: string): void }} storage
 * @param {KnownAccount[]} list
 */
export function writeKnownAccounts(storage, list) {
  try { if (list.length) storage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(list)); else storage.removeItem(KNOWN_ACCOUNTS_KEY); } catch { /* מצב פרטי או אחסון חסום: החלון פשוט לא יוצע */ }
}
