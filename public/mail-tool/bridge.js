/* עורך טיוטת המייל (mail-composer.js, newsletter.js, sheet-read.js — הועברו מאתר התוכניות) בתוך דף
   הניהול. העורך נכתב לאתר התוכניות ומצפה ל־window.RoshUI ול־window.RoshStore שלו; הקובץ הזה נותן לו
   את מה שהוא צריך מהם, מתוך דף הניהול:
   - החשבון המחובר — הסשן של דף הניהול (העוגייה), אותו חשבון Google;
   - ההעדפות שנשמרות בחשבון (העיצוב, התבניות, ההיסטוריה והעבודה על כל מייל) — באותו מקום כמו באתר
     התוכניות (/api/program/userdata, prefs), כך שכל מה שנשמר שם קודם נשאר;
   - רשימת התפוצה, כתובות ההורדה והשיתוף, וההודעות למסך (דרך דף הניהול).
   נטען לפני העורך. RoshMailBridge.configure(...) נקרא מדף הניהול לפני כל פתיחה.
   הפונקציות fmtDate, fmtDuration, hue, publicLinks וכו' — כמו ב־assets/js/ui.js באתר התוכניות. */
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cfg = { user: null, siteUrl: '', siteName: 'ראש בראש', contacts: {}, clientId: '', notify: null };

  /* ---------- עזרים כמו באתר התוכניות ---------- */
  const heDate = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const heDateShort = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  function fmtDate(iso, short) {
    if (!iso) return '';
    const d = new Date(String(iso).length === 10 ? `${iso}T12:00:00` : iso);
    return Number.isNaN(d.getTime()) ? '' : (short ? heDateShort : heDate).format(d);
  }
  function fmtDuration(sec) {
    sec = Number(sec) || 0;
    if (!sec) return '';
    const total = Math.round(sec / 60), h = Math.floor(total / 60), m = total % 60;
    if (!h) return m === 1 ? 'דקה אחת' : `${m} דקות`;
    const hw = h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
    return m ? `${hw} ו${m === 1 ? 'דקה אחת' : `־${m} דקות`}` : hw;
  }
  const seasonHue = { slater: 268, levi: 202, trio: 328, legacy: 26, sets: 158 };
  function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function hue(ep) {
    const base = seasonHue[ep?.season] ?? (hash(ep?.season || 'x') % 360);
    return (base + (hash(ep?.id || ep?.slug || '') % 46) - 23 + 360) % 360;
  }
  function isDriveUrl(value) {
    try { const u = new URL(String(value || '')); return u.protocol === 'https:' && ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(u.hostname); } catch { return false; }
  }
  const publicLinks = (ep) => (ep?.links || []).filter((l) => !isDriveUrl(l.url));
  /** יש הקלטה (קובץ ישיר או בדרייב) — אז יש כפתור הורדה, מהאחסון של האתר ובשם התוכנית */
  function hasAudio(ep) {
    if (!ep) return false;
    if (ep.r2Key || ep.audio) return true;
    return (ep.links || []).some((l) => isDriveUrl(l.url));
  }
  const downloadUrl = (ep) => (hasAudio(ep) ? `${location.origin}/api/program/download/${encodeURIComponent(ep.id)}` : '');
  const shareUrl = (ep, t = 0) => `${location.origin}/p/${encodeURIComponent(ep.slug)}${t > 5 ? `?t=${Math.floor(t)}` : ''}`;
  async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }
  function notify(text, tone) { if (cfg.notify) cfg.notify(String(text || ''), tone || 'info'); }

  /* ---------- בקשות לשרת (אותו דומיין — הסשן של דף הניהול) ---------- */
  async function call(path, { method = 'GET', body } = {}) {
    const r = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(j.error || `הפעולה נכשלה (${r.status}).`); err.status = r.status; throw err; }
    return j;
  }

  /* ---------- ההעדפות בחשבון: רק המפתחות שהעורך משנה, ממוזגים לתוך מה שבשרת ---------- */
  const prefsState = { data: {}, dirty: new Set(), timer: 0, saving: null, loaded: false };
  async function loadPrefs() {
    try { const r = await call('/api/program/userdata'); prefsState.data = { ...(r.data?.prefs || {}) }; }
    catch { prefsState.data = {}; }
    prefsState.loaded = true;
  }
  async function savePrefs() {
    clearTimeout(prefsState.timer); prefsState.timer = 0;
    if (!prefsState.dirty.size) return;
    if (prefsState.saving) { await prefsState.saving.catch(() => {}); return savePrefs(); }
    const keys = [...prefsState.dirty]; prefsState.dirty.clear();
    prefsState.saving = (async () => {
      try {
        // קודם קוראים מה בשרת (האזור האישי באתר התוכניות שומר באותו מקום), ומחליפים רק את המפתחות שלנו
        const r = await call('/api/program/userdata');
        const data = r.data && typeof r.data === 'object' ? { ...r.data } : {};
        const prefs = { ...(data.prefs || {}) };
        for (const k of keys) { if (prefsState.data[k] === undefined) delete prefs[k]; else prefs[k] = prefsState.data[k]; }
        await call('/api/program/userdata', { method: 'PUT', body: { data: { ...data, prefs } } });
      } catch {
        keys.forEach((k) => prefsState.dirty.add(k));
        if (!prefsState.timer) prefsState.timer = setTimeout(savePrefs, 30000);
      }
    })();
    try { await prefsState.saving; } finally { prefsState.saving = null; }
  }
  const prefs = {
    get(k, fb) { const v = prefsState.data[k]; return v == null ? fb : v; },
    set(k, v) {
      if (prefsState.data[k] === v) return;
      prefsState.data[k] = v; prefsState.dirty.add(k);
      clearTimeout(prefsState.timer); prefsState.timer = setTimeout(savePrefs, 1500);
    },
  };
  // סוגרים את הדף באמצע — מה שעוד לא נשמר נשלח
  window.addEventListener('pagehide', () => { if (prefsState.dirty.size) savePrefs(); });

  /* ---------- כניסה ל־Google (להרשאת gmail.compose) ---------- */
  function loadGoogle() {
    if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
    return new Promise((resolve, reject) => {
      const failed = () => reject(new Error('הכניסה של Google לא נטענה. בדקו את החיבור ונסו שוב.'));
      const existing = document.querySelector('script[src^="https://accounts.google.com/gsi/client"]');
      const wait = () => { if (window.google?.accounts?.oauth2) resolve(window.google); else setTimeout(wait, 100); };
      if (existing) { wait(); setTimeout(() => (window.google?.accounts?.oauth2 ? null : failed()), 15000); return; }
      const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = wait; sc.onerror = () => { sc.remove(); failed(); };
      document.head.appendChild(sc);
    });
  }

  const sb = {
    get user() { return cfg.user; },
    get cfg() { return { googleClientId: cfg.clientId, apiBase: location.origin }; },
    loadGoogle,
    subscribe: {
      list: () => call('/api/program/subscribers'),
      add: (content) => call('/api/program/subscribers', { method: 'POST', body: { content } }),
    },
  };

  window.RoshUI = { esc, notify, fmtDate, fmtDuration, hue, copy, downloadUrl, publicLinks, shareUrl };
  window.RoshStore = {
    sb, prefs,
    get site() { return { name: cfg.siteName, url: cfg.siteUrl }; },
    get settings() { return { contacts: cfg.contacts }; },
    scheduled: (e) => !!e?.publishAt && new Date(e.publishAt) > new Date(),
  };
  window.RoshMailBridge = {
    /** { user: {email, name}, siteUrl, contacts, clientId, notify(text, tone) } */
    configure(next) { Object.assign(cfg, next || {}); },
    loadPrefs,
    flush: savePrefs,
    get ready() { return prefsState.loaded; },
  };
})();
