// הגדרות הקו: מספר ההעברה בסיום השיחה, זמני ההמתנה להקשה ומספר החזרות על
// תפריט. הן נקבעות במסך הניהול באתר (GET /api/ivr/line-settings), וכך אין צורך
// לשנות משתני סביבה ולפרוס מחדש. לכל ערך סדר עדיפות קבוע:
//   1. הערך שנקבע באתר (אם נקבע ועומד בגבולות);
//   2. משתנה הסביבה של השירות (POST_VOTE_TRANSFER, IVR_SEC_WAIT,
//      IVR_MENU_SEC_WAIT, IVR_MENU_REPEATS) — בדיוק כפי שנקרא עד היום;
//   3. ברירת המחדל הקבועה.
// כשהאתר אינו עונה נשארים הערכים האחרונים שהתקבלו ממנו, ואם עוד לא התקבל
// דבר — משתני הסביבה. בלי שום הגדרה באתר הקו מתנהג בדיוק כמו קודם.
const { DEFAULT_POST_VOTE_TRANSFER, resolvePostVoteTransfer } = require("./phone");

// חייבים להתאים ל-worker/ivr-line-settings.js (נבדק בבדיקות).
const LINE_SETTING_DEFAULTS = Object.freeze({
  postVoteTransfer: DEFAULT_POST_VOTE_TRANSFER,
  votingWaitSeconds: 20,
  adminWaitSeconds: 5,
  menuRepeats: 0,
});

const LINE_SETTING_LIMITS = Object.freeze({
  votingWaitSeconds: Object.freeze({ min: 7, max: 60 }),
  adminWaitSeconds: Object.freeze({ min: 2, max: 20 }),
  menuRepeats: Object.freeze({ min: 0, max: 5 }),
});

const ENV_NAMES = Object.freeze({
  postVoteTransfer: "POST_VOTE_TRANSFER",
  votingWaitSeconds: "IVR_SEC_WAIT",
  adminWaitSeconds: "IVR_MENU_SEC_WAIT",
  menuRepeats: "IVR_MENU_REPEATS",
});

const NUMERIC_KEYS = ["votingWaitSeconds", "adminWaitSeconds", "menuRepeats"];

function siteInteger(value, { min, max }) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

// אותה קריאה של משתני הסביבה שהייתה ב-menu-input.js: ערך חסר, אפס או לא
// מספרי נופל לברירת המחדל, ומה שמחוץ לגבולות נחתך אליהם. מספר החזרות מעוגל
// למטה, ואפס בו הוא ערך לגיטימי.
function envInteger(key, raw) {
  const { min, max } = LINE_SETTING_LIMITS[key];
  const fallback = LINE_SETTING_DEFAULTS[key];
  const text = String(raw ?? "").trim();
  if (key === "menuRepeats") {
    const number = Math.floor(Number(text));
    if (!text || !Number.isFinite(number)) return { value: fallback, source: "default" };
    return { value: Math.min(Math.max(number, min), max), source: "env" };
  }
  const number = Number(text);
  if (!number) return { value: fallback, source: "default" };
  return { value: Math.min(Math.max(number, min), max), source: "env" };
}

function resolveTransfer(siteValue, envValue) {
  const site = typeof siteValue === "string" ? siteValue.trim() : "";
  if (/^off$/i.test(site)) return { value: "", source: "site" };
  if (/^0\d{8,9}$/.test(site)) return { value: site, source: "site" };
  const env = String(envValue ?? "").trim();
  return { value: resolvePostVoteTransfer(envValue), source: env ? "env" : "default" };
}

/**
 * הערכים בפועל לשיחה. `site` הוא `settings` מתשובת האתר (או null כשאין),
 * `env` הוא process.env. ערך מהאתר שאינו תקין מדולג, כאילו לא נקבע.
 * `postVoteTransfer` הריק פירושו שההעברה כבויה והשיחה מסתיימת בניתוק.
 */
function resolveLineSettings(site, env = process.env) {
  const values = site && typeof site === "object" ? site : {};
  const transfer = resolveTransfer(values.postVoteTransfer, env[ENV_NAMES.postVoteTransfer]);
  const settings = { postVoteTransfer: transfer.value };
  const sources = { postVoteTransfer: transfer.source };
  for (const key of NUMERIC_KEYS) {
    const fromSite = siteInteger(values[key], LINE_SETTING_LIMITS[key]);
    if (fromSite !== null) { settings[key] = fromSite; sources[key] = "site"; continue; }
    const fromEnv = envInteger(key, env[ENV_NAMES[key]]);
    settings[key] = fromEnv.value;
    sources[key] = fromEnv.source;
  }
  return { ...settings, sources };
}

/**
 * שמירה קצרה בזיכרון של ההגדרות מהאתר. כל שיחה מבקשת את ההגדרות; אם עברה
 * יותר מ-`ttlMs` מהטעינה האחרונה הן נטענות מחדש (בקשה אחת גם כשכמה שיחות
 * נכנסות יחד), כך ששינוי במסך הניהול תופס בתוך כדקה. כשהטעינה נכשלת נשארים
 * הערכים האחרונים שהתקבלו, ולא מנסים שוב לפני `retryMs`, כדי שאתר שאינו עונה
 * לא יעכב כל שיחה.
 */
function createLineSettingsLoader({ fetchSettings, env = process.env, ttlMs = 60000, retryMs = 15000, now = Date.now, onError = () => {} }) {
  let site = null;
  let loadedAt = null;
  let retryAt = 0;
  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        site = (await fetchSettings()) || null;
        loadedAt = now();
      } catch (error) {
        retryAt = now() + retryMs;
        onError(error);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function stale() {
    if (loadedAt !== null && now() - loadedAt < ttlMs) return false;
    return now() >= retryAt;
  }

  return {
    async get() {
      if (stale()) await refresh();
      return resolveLineSettings(site, env);
    },
    peek() { return resolveLineSettings(site, env); },
    refresh,
  };
}

// ימות המשיח משמיעה את התפריט `amount_attempts` פעמים לפני שהיא מחשיבה אותו
// כלא נענה. בלי הערך הזה היא משמיעה פעם אחת, ולכן אפס חזרות לא שולח אותו
// כלל — וכך ההתנהגות זהה לזו שהייתה לפני ההגדרה.
function withMenuRepeats(options, repeats) {
  const count = Math.floor(Number(repeats)) || 0;
  return count > 0 ? { ...options, amount_attempts: count + 1 } : options;
}

module.exports = { ENV_NAMES, LINE_SETTING_DEFAULTS, LINE_SETTING_LIMITS, createLineSettingsLoader, resolveLineSettings, withMenuRepeats };
