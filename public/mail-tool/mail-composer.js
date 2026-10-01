/* טיוטות מייל לרשימת התפוצה — העורך, התצוגה המקדימה והיצירה בג'ימייל.
   שלושה סוגים: תוכנית חדשה, סיכום של כמה תוכניות, והודעה חופשית.
   הטיוטה נוצרת ישירות בתיקיית "טיוטות" של חשבון ה־Google המחובר (Gmail API, הרשאת
   gmail.compose בלבד — טיוטות ושליחה, בלי לקרוא את הדואר), עם כל רשימת התפוצה בעותק
   מוסתר. לרשימה שום דבר לא נשלח מכאן — שולחים מג'ימייל. ("שליחת בדיקה" שולחת רק אליכם.)
   הלשוניות: תוכן (בלוקים בסדר של המייל, עיצוב טקסט, משתנים, הצעות לנושא), עיצוב (סגנון,
   גופן, תמונה, תבניות שמורות), נמענים (רשימה, ייבוא, תיקון טעויות הקלדה, "לא לשלוח אל"),
   בדיקה (מה לתקן לפני יצירה), היסטוריה (הטיוטות שנוצרו — מצב, פתיחה, החלפה ומחיקה).
   בחשבון (לא במכשיר) נשמרים: העיצוב והניסוח לפעם הבאה, התבניות, ההיסטוריה, והעבודה על
   כל מייל — כך שאפשר לסגור באמצע ולחזור.
     RoshMailComposer.mount(el, cfg) — בתוך דף (mail.html)
     RoshMailComposer.open(cfg)      — בחלון (אזור הניהול)
   cfg: { episodes(): [], episodeId, kind, isLive(e), contacts() } */
(function () {
  'use strict';
  const U = window.RoshUI, S = window.RoshStore, M = window.RoshMail;
  const { esc } = U;
  const SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const PREF = 'mailDraft', TEMPLATES = 'mailTemplates', HISTORY = 'mailHistory', WORK = 'mailWork';
  const TITLE = '{{title}}';   // בניסוח שנשמר לפעם הבאה, שם התוכנית מתחלף בשם של התוכנית הבאה
  const label = (e) => String(e?.title || '').trim() || 'תוכנית בלי שם';
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.number || 0) - (a.number || 0);
  const fmtN = (n) => Number(n || 0).toLocaleString('he-IL');
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  const cut = (s, n = 8000) => String(s ?? '').slice(0, n);
  const clamp = (n, lo, hi, fb) => { const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb; };
  // כמה בעותק המוסתר בכל טיוטה: עד מה שבחרו — וביחד עם מי שב"אל" לא יותר מהמגבלה היומית, ולא יותר
  // מ־500 נמענים בהודעה אחת (המגבלה של ג'ימייל; גם ב־Workspace — לנמענים מחוץ לארגון)
  const perDraft = (size, L, to = 1) => Math.max(1, Math.min(size, L - to, 500 - to));
  function when(ts) {
    const d = new Date(Number(ts)); if (!ts || Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    return new Date().toDateString() === d.toDateString() ? `היום ${time}` : `${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })} ${time}`;
  }

  /* ---------- ההרשאה לג'ימייל: טוקן קצר בזיכרון בלבד ---------- */

  const auth = { token: '', exp: 0, client: null, waiter: null, loading: null, error: '' };
  const AUTH_ERRORS = {
    access_denied: 'לא אישרתם לאתר ליצור טיוטות בג\'ימייל. לחצו שוב, ובחלון של Google סמנו את האפשרות "ניהול טיוטות ושליחת אימיילים".',
    popup_failed_to_open: 'הדפדפן חסם את החלון של Google. אפשרו חלונות קופצים לאתר הזה ונסו שוב.',
    popup_closed: 'החלון של Google נסגר לפני שאישרתם. לחצו שוב כדי לנסות.',
  };
  const authError = (type) => {
    // "לא אישרתם" או "החלון נסגר" — כנראה לא היה ברור מה ללחוץ במסך של Google: בפעם הבאה ההסבר מופיע שוב
    if (type === 'access_denied' || type === 'popup_closed') introSeen(false);
    return Object.assign(new Error(AUTH_ERRORS[type] || `Google לא אישר את הגישה לג'ימייל${type ? ` (${type})` : ''}. נסו שוב.`), { code: type });
  };

  /* ---------- הסבר חד־פעמי לפני החיבור הראשון ----------
     האפליקציה של Google לא מאומתת, ולכן בפעם הראשונה Google מציג מסך אזהרה. לפני שהוא נפתח
     מסבירים מה ללחוץ. "ראיתם" נשמר בחשבון (כמו mailDraft) ובגיבוי במכשיר. */
  const INTRO = 'mailAuthIntroSeen';
  function introSeen(set) {
    if (set === undefined) {
      if (S.prefs.get(INTRO, false) === true) return true;
      try { return localStorage.getItem(`rosh:${INTRO}`) === '1'; } catch { return false; }
    }
    S.prefs.set(INTRO, !!set);
    try { if (set) localStorage.setItem(`rosh:${INTRO}`, '1'); else localStorage.removeItem(`rosh:${INTRO}`); } catch { /* */ }
    return !!set;
  }
  /** צריך להסביר לפני שחלון Google נפתח: אין טוקן תקף, וההסבר עוד לא נראה (או שהחיבור הקודם נכשל) */
  const needsIntro = () => !hasToken() && !introSeen();
  /** חלון ההסבר. onContinue נקרא ישירות מתוך הלחיצה על "הבנתי" — כך getToken() שבתוכו
      פותח את חלון Google בלי שהדפדפן יחסום אותו. */
  function authIntro(onContinue) {
    prepare();   // הספרייה של Google נטענת כבר עכשיו, כדי שהלחיצה על "המשך" תפתח את החלון מיד
    document.getElementById('dlg-gmail-intro')?.remove();
    const d = document.createElement('dialog');
    d.id = 'dlg-gmail-intro';
    d.className = 'sheet gmail-intro mail-tool';   // בדף הניהול: העיצוב של העורך חל רק בתוך .mail-tool
    d.setAttribute('aria-labelledby', 'gmail-intro-title');
    d.innerHTML = `
<div class="section-title"><div><p class="kicker">ג'ימייל</p><h2 id="gmail-intro-title">חיבור חד־פעמי ל־Gmail</h2></div><button type="button" class="icon-btn" data-gi="cancel" aria-label="ביטול">✕</button></div>
<div class="card-body">
  <p>כדי שהאתר יוכל ליצור טיוטות בתיבת ה־Gmail שלך, צריך לאשר פעם אחת את החיבור.</p>
  <p class="gi-warn"><span aria-hidden="true">⚠</span>ייפתח חלון של Google עם אזהרה שהאפליקציה לא מאומתת — זה תקין, זו האפליקציה של האתר.</p>
  <ol class="gi-steps">
    <li>לחצו <b>'מתקדם'</b> <span dir="ltr">(Advanced)</span></li>
    <li>לחצו <b>'מעבר אל … (לא בטוח)'</b></li>
    <li>סמנו את התיבה <b>'ניהול טיוטות ושליחת אימיילים'</b></li>
    <li>לחצו <b>'המשך'</b></li>
  </ol>
  <p class="gi-note">האתר לא קורא את המיילים שלכם — הוא רק יוצר טיוטות. אחרי האישור לא תצטרכו לעשות זאת שוב.</p>
</div>
<div class="card-foot"><button type="button" class="btn" data-gi="cancel">ביטול</button><button type="button" class="btn primary" data-gi="go">הבנתי, המשך לאישור <span>←</span></button></div>`;
    document.body.appendChild(d);
    const close = () => { d.close(); d.remove(); };
    d.addEventListener('click', (ev) => {
      if (ev.target === d || ev.target.closest('[data-gi="cancel"]')) { close(); return; }
      if (ev.target.closest('[data-gi="go"]')) {
        introSeen(true);
        close();
        onContinue();   // בלי await לפני — getToken() חייב לרוץ בתוך הלחיצה
      }
    });
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
    d.showModal();
    d.querySelector('[data-gi="go"]').focus();
  }
  /** טוען מראש את הספרייה של Google, כדי שהלחיצה על "יצירה" תפתח את חלון האישור מיד (דפדפנים חוסמים חלון שנפתח באיחור) */
  function prepare() {
    if (auth.client) return Promise.resolve();
    if (auth.loading) return auth.loading;
    const clientId = S.sb.cfg?.googleClientId;
    if (!clientId) { auth.error = 'כניסה עם Google אינה מוגדרת באתר הזה.'; return Promise.resolve(); }
    auth.loading = S.sb.loadGoogle().then((g) => {
      const o = g.accounts?.oauth2;
      if (!o?.initTokenClient) throw new Error('הספרייה של Google לא נטענה במלואה. רעננו את הדף.');
      auth.client = o.initTokenClient({
        client_id: clientId, scope: SCOPE, include_granted_scopes: true, prompt: '', login_hint: S.sb.user?.email || '',
        callback: (r) => {
          const w = auth.waiter; auth.waiter = null; if (!w) return;
          if (r?.error) return w.reject(authError(r.error));
          if (o.hasGrantedAllScopes && !o.hasGrantedAllScopes(r, SCOPE)) return w.reject(authError('access_denied'));
          auth.token = r.access_token; auth.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          w.resolve(auth.token);
        },
        error_callback: (e) => { const w = auth.waiter; auth.waiter = null; w?.reject(authError(e?.type)); },
      });
      auth.error = '';
    }).catch((err) => { auth.error = err.message; }).finally(() => { auth.loading = null; });
    return auth.loading;
  }
  const hasToken = () => !!auth.token && Date.now() < auth.exp - 60000;
  /** חייב להיקרא ישירות מתוך הלחיצה (בלי await לפניו) — אחרת הדפדפן חוסם את החלון של Google */
  function getToken() {
    if (hasToken()) return Promise.resolve(auth.token);
    if (!auth.client) { prepare(); return Promise.reject(new Error(auth.error || 'החיבור ל־Google עוד נטען — לחצו שוב בעוד רגע.')); }
    auth.waiter?.reject(new Error('הבקשה הוחלפה בבקשה חדשה.'));
    return new Promise((resolve, reject) => {
      // חלון שלא החזיר תשובה (נסגר בלי הודעה) לא משאיר את הכפתור תקוע
      const timer = setTimeout(() => { if (auth.waiter?.resolve === done) { auth.waiter = null; reject(authError('popup_closed')); } }, 180000);
      const done = (t) => { clearTimeout(timer); resolve(t); };
      auth.waiter = { resolve: done, reject: (e) => { clearTimeout(timer); reject(e); } };
      auth.client.requestAccessToken({ login_hint: S.sb.user?.email || '' });
    });
  }
  function gmailError(status, j) {
    const msg = String(j?.error?.message || ''), why = `${msg} ${j?.error?.status || ''} ${(j?.error?.errors || []).map((x) => x.reason).join(' ')}`;
    let text;
    if (status === 401) { auth.token = ''; text = 'ההרשאה לג\'ימייל פגה. לחצו שוב.'; }
    else if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(why)) text = 'ה־Gmail API עוד לא הופעל בפרויקט של Google שהאתר משתמש בו — ההוראות בקובץ README של האתר. בינתיים אפשר ללחוץ "העתקת המייל" ולהדביק בהודעה חדשה בג\'ימייל.';
    else if (status === 403) { auth.token = ''; text = 'ג\'ימייל לא אישר את הפעולה בחשבון הזה. לחצו שוב וסמנו בחלון של Google את האפשרות לנהל טיוטות.'; }
    else if (status === 404) text = 'הטיוטה לא נמצאה בג\'ימייל — כנראה נשלחה או נמחקה.';
    else if (status === 429) text = 'יותר מדי בקשות לג\'ימייל ברגע אחד. נסו שוב בעוד דקה.';
    else text = `ג'ימייל החזיר שגיאה (${status})${msg ? `: ${msg}` : ''}.`;
    return Object.assign(new Error(text), { status });
  }
  async function gmail(path, { method = 'GET', body } = {}) {
    let r;
    try { r = await fetch(`${GMAIL}${path}`, { method, headers: { Authorization: `Bearer ${auth.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error('אין חיבור לג\'ימייל כרגע. בדקו את החיבור ונסו שוב.'); }
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw gmailError(r.status, j);
    return j;
  }
  const inbox = (email) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}`;
  const draftUrl = (email, messageId) => `${inbox(email)}#drafts?compose=${encodeURIComponent(messageId)}`;

  /* ---------- מה שנשמר בחשבון ---------- */

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // רק השם כשהוא עומד לבד (מוקף בגרשיים, בנקודתיים, במקף, באימוג'י או בקצה השורה) — לא מילים בתוך משפט
  // ("שנה טובה ומתוקה"), ולא חלק משם אחר ("פרק 2" בתוך "פרק 25")
  const toTemplate = (text, e) => { const t = label(e); return e && t.length > 1 ? String(text ?? '').replace(new RegExp(`(?<![\\p{L}\\p{N}][ \\u00a0]?)${escRe(t)}(?![ \\u00a0]?[\\p{L}\\p{N}])`, 'gu'), TITLE) : String(text ?? ''); };
  const fill = (text, e) => (e ? String(text ?? '').split(TITLE).join(label(e)) : String(text ?? ''));
  // העיצוב והניסוח שעוברים ממייל למייל
  const KEEP = ['style', 'accent', 'cover', 'font', 'shape', 'listenLabel', 'downloadLabel', 'signature', 'descTitle', 'tracksTitle', 'moreTitle', 'shareTitle', 'shareText', 'ctaLabel', 'ctaUrl'];
  // לכל סוג מייל בנפרד, כתבנית לפעם הבאה (שם התוכנית → {{title}})
  const TEXT = ['subject', 'intro', 'headline', 'preheader'];
  // העבודה על מייל מסוים — נשמרת לפי התוכנית (או הסוג), כדי שאפשר יהיה לסגור ולחזור
  // (גם התמונה משלכם: באנר לחג לא אמור להפוך לתמונה של כל תוכנית אחריו)
  const WORKED = [...TEXT, 'description', 'descTitle', 'quote', 'quoteBy', 'siteLabel', 'image'];
  const hid = (h) => `${h.at}|${h.key}`;   // מזהה של טיוטה בהיסטוריה
  const OPT = new Set([...WORKED, 'signature', 'listenLabel', 'downloadLabel', 'tracksTitle', 'ctaLabel', 'ctaUrl', 'moreTitle', 'shareTitle', 'shareText', 'image']);
  const DONE = new Set(['gone', 'replaced', 'deleted']);
  const TABS = [['content', 'תוכן'], ['design', 'עיצוב'], ['people', 'נמענים'], ['check', 'בדיקה'], ['history', 'היסטוריה']];
  const KIND_ICON = { episode: '▶', digest: '☰', note: '✎' };
  const EMOJI = ['🎙️', '🎧', '🎶', '🎵', '📻', '✨', '🔥', '❤️', '👏', '📣', '🗓️', '⭐', '✦', '🎉', '🙏', '👇'];
  // הדוגמאות משמאל לימין, כדי שהסוגריים והכוכביות יוצגו כמו שמקלידים אותם
  const FORMAT_HINT = 'שורה ריקה פותחת פסקה. <code dir="ltr">**הדגשה**</code> · <code dir="ltr">*נטוי*</code> · <code dir="ltr">[טקסט](https://…)</code> · שורה שמתחילה ב־<code dir="ltr">- </code> היא רשימה.';
  const STATE = { open: ['מחכה בטיוטות', 'teal'], gone: ['נשלחה או נמחקה', ''], replaced: ['הוחלפה בחדשה', ''], deleted: ['נמחקה מכאן', ''] };
  let uidSeq = 0;

  /* ---------- העורך ---------- */

  function mount(root, cfg = {}) {
    const uid = ++uidSeq;
    const contacts = () => cfg.contacts?.() || S.settings?.contacts || {};
    const prefs = obj(S.prefs.get(PREF, null));
    const st = {
      kind: M.own(M.KINDS, cfg.kind) ? cfg.kind : 'episode', id: '', digest: [], opts: null, prefs,
      tab: 'content', view: 'desktop', expanded: new Set(['intro', 'description']),
      busy: false, error: '', errorForce: false, errorReplace: false, progress: '', account: '', accountToken: '', restored: 0, dirty: false, pending: false, last: null, lastResult: null, checking: false, quality: null,
      mode: 'all', to: S.sb.user?.email || '', replyTo: '', chunk: 400, exclude: [],
      rcp: { state: 'loading', list: [], error: '', source: '' },
      server: new Set(), serverOk: false,   // מה שכבר ברשימת התפוצה בשרת (כתובות חדשות אפשר לשמור בה)
      lines: new Map(),                      // כתובת → השורה שממנה נלקחה (עם השם), לשמירה ברשימה
      history: [],
    };
    /* התבניות, ההיסטוריה והעבודה נקראות מהחשבון בכל פעם מחדש (ומתמזגות לפני שמירה) —
       כך לשונית או מכשיר נוסף לא דורסים זה את זה */
    const templates = () => arr(S.prefs.get(TEMPLATES, null)).filter((t) => t && t.name && t.data);
    const work = () => obj(S.prefs.get(WORK, null));
    const forgotten = new Set();   // מה שהוסר מההיסטוריה כאן — לא חוזר ממיזוג
    function syncHistory() {
      const all = new Map(st.history.map((h) => [hid(h), h]));
      for (const h of arr(S.prefs.get(HISTORY, null))) {
        if (!h || !h.at || !h.key || !Array.isArray(h.drafts) || forgotten.has(hid(h))) continue;
        const mine = all.get(hid(h));
        if (!mine) all.set(hid(h), h);
        else if (DONE.has(h.state) && !DONE.has(mine.state)) mine.state = h.state;   // נמחקה/הוחלפה במקום אחר
      }
      st.history = [...all.values()].sort((a, b) => b.at - a.at).slice(0, 30);
    }
    syncHistory();
    st.chunk = clamp(prefs.chunk, 1, 2000, 400);
    st.replyTo = typeof prefs.replyTo === 'string' ? prefs.replyTo : String(contacts().email || '');
    st.exclude = M.parseEmails(arr(prefs.exclude).join('\n'));

    const eps = () => (cfg.episodes?.() || []).slice().sort(byDate);
    const ep = () => (st.kind === 'episode' ? eps().find((e) => e.id === st.id) || null : null);
    const isLive = (e) => (cfg.isLive ? cfg.isLive(e) : e.visible && !S.scheduled(e));
    const liveEps = () => eps().filter(isLive);
    const digestEps = () => st.digest.map((id) => eps().find((e) => e.id === id)).filter(Boolean).sort(byDate);
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => [...root.querySelectorAll(s)];
    const keyFor = (kind = st.kind, id = st.id) => (kind === 'episode' ? `ep:${id}` : kind);
    const base = () => (S.site || {}).url || new URL('.', location.href).href;
    const abs = (path) => new URL(path, base()).href;
    const listenUrl = (e) => abs(`episode.html?ep=${encodeURIComponent(e.slug || e.id)}&utm_source=email`);
    // ref=email: ההורדות מהמייל נספרות בסטטיסטיקה בנפרד ("מאיפה הורידו")
    const downloadFor = (e) => { const u = U.downloadUrl(e); return u.includes('/api/program/download/') ? `${u}?ref=email` : u; };
    const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    function excerpt(text, max = 170) {
      const s = M.plain(String(text || '')).split('\n\n')[0].replace(/\s+/g, ' ').trim();
      if (s.length <= max) return s;
      const c = s.slice(0, max);
      return `${c.slice(0, Math.max(c.lastIndexOf(' '), Math.floor(max * 0.6))).trim()}…`;
    }
    const itemFor = (e) => ({ id: e.id, title: label(e), number: e.number, url: listenUrl(e), downloadUrl: downloadFor(e), dateText: e.date ? U.fmtDate(e.date) : '', durationText: e.duration ? U.fmtDuration(e.duration) : '', thumb: e.thumb || e.cover || '', hue: U.hue(e), excerpt: excerpt(e.description) });

    function ctxFor(kind = st.kind, e = ep()) {
      const site = S.site || {};
      const items = kind === 'digest' ? digestEps().map(itemFor) : [];
      const c = {
        siteName: site.name || 'ראש בראש', tagline: site.tagline || '', siteUrl: base(),
        homeUrl: abs('?utm_source=email'), archiveUrl: abs('archive.html?utm_source=email'), unsubscribeUrl: abs('me.html#me-subscribe'),
        contacts: contacts(), items, more: kind === 'digest' ? [] : liveEps().filter((x) => !e || x.id !== e.id).slice(0, 4).map(itemFor),
        hue: e ? U.hue(e) : items[0]?.hue ?? 268, dateText: U.fmtDate(todayIso()), shareUrl: base(),
      };
      if (e) Object.assign(c, { listenUrl: listenUrl(e), downloadUrl: downloadFor(e), shareUrl: U.shareUrl(e), dateText: e.date ? U.fmtDate(e.date) : '', durationText: e.duration ? U.fmtDuration(e.duration) : '', links: U.publicLinks(e) });
      return c;
    }
    function optionsFor(kind, e) {
      const p = st.prefs = obj(S.prefs.get(PREF, null)), d = M.defaults(e, ctxFor(kind, e), kind);
      const o = { ...d, show: { ...d.show, ...obj(p.show) } };
      KEEP.forEach((k) => { if (typeof p[k] === 'string') o[k] = p[k]; });
      o.moreCount = clamp(p.moreCount, 1, 4, d.moreCount);
      o.blocks = M.blocksFor({ blocks: p.blocks, show: p.show });
      const txt = kind === 'episode' ? p : obj(obj(p.byKind)[kind]);
      TEXT.forEach((k) => { if (typeof txt[k] === 'string' && (txt[k].trim() || k === 'preheader')) o[k] = fill(txt[k], e); });
      if (!M.own(M.STYLES, o.style)) o.style = 'night';
      if (!M.own(M.FONT_SETS, o.font)) o.font = 'modern';
      if (!M.own(M.SHAPES, o.shape)) o.shape = 'pill';
      if (!['head', 'full', 'none'].includes(o.cover)) o.cover = 'head';   // "ליד הכותרת" מגרסה קודמת → בכותרת
      // העבודה שנשמרה על המייל הזה (אם סגרו באמצע)
      const w = obj(work()[keyFor(kind, e?.id)]);
      st.restored = 0;
      if (w.o) { WORKED.forEach((k) => { if (typeof w.o[k] === 'string') o[k] = w.o[k]; }); st.restored = Number(w.at) || 1; }
      return o;
    }
    function digestDefault() {
      const ids = arr(obj(work().digest).digest).filter((id) => eps().some((e) => e.id === id));
      return ids.length ? ids : liveEps().slice(0, 3).map((e) => e.id);
    }

    let saveTimer = 0;
    function save() { st.pending = true; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); }
    /** שומר בחשבון: העיצוב והניסוח לפעם הבאה, ואם נערך תוכן — גם את העבודה על המייל הזה */
    function flush() {
      clearTimeout(saveTimer);
      const o = st.opts; if (!o || (!st.pending && !st.dirty)) return;
      const e = ep(), p = { ...obj(S.prefs.get(PREF, null)) };
      KEEP.forEach((k) => { p[k] = o[k]; });
      delete p.image;   // נשמר פעם כאן — עכשיו רק במייל עצמו
      Object.assign(p, { show: { ...o.show }, blocks: o.blocks.map((b) => ({ id: b.id, on: b.on })), moreCount: o.moreCount, chunk: st.chunk, replyTo: st.replyTo, exclude: st.exclude.slice(0, 500) });
      const txt = Object.fromEntries(TEXT.map((k) => [k, cut(toTemplate(o[k], e), 2000)]));
      if (st.kind === 'episode') Object.assign(p, txt); else p.byKind = { ...obj(p.byKind), [st.kind]: txt };
      st.prefs = p; S.prefs.set(PREF, p);
      if (st.dirty) {
        // התיאור נשמר רק אם נערך למייל — אחרת בפעם הבאה ייכנס התיאור העדכני מהאתר
        const keep = WORKED.filter((k) => k !== 'description' || (st.kind === 'episode' && o.description !== String(e?.description || '')));
        const all = { ...work(), [keyFor()]: { at: Date.now(), o: Object.fromEntries(keep.map((k) => [k, k === 'description' ? String(o[k]) : cut(o[k])])), ...(st.kind === 'digest' ? { digest: st.digest.slice(0, 60) } : {}) } };
        S.prefs.set(WORK, Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 8)));   // רק המיילים האחרונים
      }
      st.pending = false; st.dirty = false;
    }
    const saveHistory = () => { syncHistory(); S.prefs.set(HISTORY, st.history.slice()); };
    const built = () => { const e = ep(); return st.kind === 'episode' && !e ? null : M.build(e, ctxFor(), { ...st.opts, kind: st.kind }); };
    const effective = () => { const x = new Set(st.exclude); return st.rcp.list.filter((a) => !x.has(a)); };
    const limit = () => M.dailyLimit(st.account || S.sb.user?.email);
    const auditInfo = () => ({ live: st.kind === 'episode' && ep() ? isLive(ep()) : true, mode: st.mode, recipients: effective().length, limit: limit(), typos: st.quality?.typos || [], risky: st.quality?.risky || [] });
    const prevFor = (key) => st.history.find((h) => h.key === key && h.mode !== 'me' && !DONE.has(h.state));

    function pick(id) {
      flush();
      st.id = id;
      if (!ep()) return;
      st.opts = optionsFor('episode', ep());   // הניסוח והעיצוב נשמרו כתבנית — רק שם התוכנית מתחלף
      renderPanel('content'); renderPanel('design'); paintAll();
    }
    function setKind(k) {
      if (!M.own(M.KINDS, k) || k === st.kind) return;
      flush();
      st.kind = k; st.error = ''; st.errorForce = false;
      if (k === 'digest' && !st.digest.length) st.digest = digestDefault();
      if (k === 'episode' && !ep()) st.id = (eps().find(isLive) || eps()[0])?.id || '';
      st.opts = optionsFor(k, ep());
      render();
    }

    /* ---------- ה־HTML של העורך ---------- */

    const menu = (cls, face, title, inner, up) => `<details class="mc-menu ${cls}"><summary class="btn small" title="${esc(title)}" aria-label="${esc(title)}">${face}</summary><div class="mc-menu-list${up ? ' up' : ''}">${inner}</div></details>`;
    const tokenMenu = (target) => menu('mc-tok', '{ }', 'משתנים — מתמלאים לפי התוכנית', M.TOKENS.map(([k, t]) => `<button type="button" data-mtoken="{{${k}}}" data-target="${target}"><code dir="ltr">{{${k}}}</code><span>${esc(t)}</span></button>`).join(''));
    const emojiMenu = (target) => menu('mc-emo', '☺', 'אימוג\'י', `<div class="mc-emoji">${EMOJI.map((x) => `<button type="button" data-memoji="${x}" data-target="${target}" aria-label="${x}">${x}</button>`).join('')}</div>`);
    const toolbar = (key) => `<div class="mc-tools" role="toolbar" aria-label="עיצוב הטקסט">
<button type="button" data-mfmt="bold" data-target="${key}" title="הדגשה (Ctrl+B)" aria-label="הדגשה"><b>B</b></button><button type="button" data-mfmt="italic" data-target="${key}" title="נטוי (Ctrl+I)" aria-label="נטוי"><i>I</i></button><button type="button" data-mfmt="link" data-target="${key}" title="קישור" aria-label="קישור">🔗</button><button type="button" data-mfmt="ul" data-target="${key}" title="רשימה" aria-label="רשימה">•</button><button type="button" data-mfmt="ol" data-target="${key}" title="רשימה ממוספרת" aria-label="רשימה ממוספרת">1.</button>${tokenMenu(key)}${emojiMenu(key)}</div>`;
    const ta = (key, rows, ph = '') => `${toolbar(key)}<textarea data-m="${key}" rows="${rows}" placeholder="${esc(ph)}" aria-label="${esc(blockName(key === 'intro' ? 'intro' : key))}">${esc(st.opts[key])}</textarea>`;
    const check = (k, text, ok = true, why = '') => `<label class="check${ok ? '' : ' off'}"><input type="checkbox" data-mshow="${k}" ${st.opts.show[k] && ok ? 'checked' : ''} ${ok ? '' : 'disabled'}> ${esc(text)}${ok || !why ? '' : ` <small>(${esc(why)})</small>`}</label>`;
    const blockName = (id) => (id === 'intro' && st.kind === 'note' ? 'ההודעה' : M.BLOCKS[id]?.name || '');

    function render() {
      const noEps = !eps().length;
      root.innerHTML = `
<div class="mail-composer" data-kind="${st.kind}">
  <div class="mc-form">
    <div class="mc-kinds" role="radiogroup" aria-label="סוג המייל">${Object.entries(M.KINDS).map(([k, x]) => `<button type="button" role="radio" class="mc-kind" data-mkind="${k}" aria-checked="${st.kind === k}" ${k !== 'note' && noEps ? 'disabled' : ''}><i aria-hidden="true">${KIND_ICON[k]}</i><b>${esc(x.name)}</b><small>${esc(x.hint)}</small></button>`).join('')}</div>
    <nav class="mc-quickflow" aria-label="המסלול המהיר ליצירת טיוטה">
      <p class="mc-quickflow-title">יוצרים טיוטה בשלושה שלבים</p>
      <div class="mc-steps">
        <button type="button" class="mc-step" data-mstep="content" aria-pressed="${st.tab === 'content'}"><i>1</i><span><b>תוכן</b><small>נושא ונוסח</small></span></button>
        <button type="button" class="mc-step" data-mstep="people" aria-pressed="${st.tab === 'people'}"><i>2</i><span><b>נמענים</b><small>מי יקבל את הטיוטה</small></span></button>
        <button type="button" class="mc-step" data-mstep="check" aria-pressed="${st.tab === 'check'}"><i>3</i><span><b>בדיקה</b><small>עוברים על המייל לפני יצירה</small></span></button>
      </div>
      <p class="mc-quickflow-note">אחרי הבדיקה יוצרים טיוטה בג׳ימייל; המייל לא נשלח מכאן.</p>
    </nav>
    <div class="mc-tabs" role="tablist" aria-label="חלקי העורך">${TABS.map(([k, t]) => `<button type="button" role="tab" id="mc${uid}-tab-${k}" data-mtab="${k}" aria-selected="${st.tab === k}" aria-controls="mc${uid}-panel-${k}" tabindex="${st.tab === k ? 0 : -1}">${t}<span class="mc-badge" data-mbadge="${k}"></span></button>`).join('')}</div>
    ${TABS.map(([k]) => `<div class="mc-panel" role="tabpanel" id="mc${uid}-panel-${k}" aria-labelledby="mc${uid}-tab-${k}" data-panel="${k}" ${st.tab === k ? '' : 'hidden'}></div>`).join('')}
  </div>

  <div class="mc-preview">
    <div class="mc-preview-head">
      <p class="kicker">כך זה ייראה בתיבת הדואר</p>
      <div class="segmented" role="group" aria-label="התצוגה">${[['desktop', 'מחשב'], ['phone', 'טלפון'], ['text', 'טקסט']].map(([k, t]) => `<button type="button" data-mview="${k}" aria-pressed="${st.view === k}">${t}</button>`).join('')}</div>
    </div>
    <div class="mc-inbox${st.view === 'phone' ? ' phone' : ''}" data-m-inbox aria-hidden="true"><span class="mc-av">${esc((S.site?.name || 'ר').trim().charAt(0))}</span><span class="mc-inbox-lines"><b>${esc(S.site?.name || 'ראש בראש')}</b><span data-m-inbox-subject></span><small data-m-inbox-pre></small></span><time>עכשיו</time></div>
    <div class="mc-frame-wrap${st.view === 'phone' ? ' phone' : ''}" data-m-framewrap><iframe data-m-frame title="תצוגה מקדימה של המייל" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" ${st.view === 'text' ? 'hidden' : ''}></iframe><pre class="mc-text" data-m-text dir="rtl" ${st.view === 'text' ? '' : 'hidden'}></pre></div>
    <div class="mc-meter" data-m-meter></div>
  </div>

  <div class="mc-foot">
    <button type="button" class="btn xl primary" data-mop="create" title="Ctrl+Enter">יצירת טיוטה בג'ימייל <span>←</span></button>
    <button type="button" class="mc-auth-help" data-mop="auth-help">איך מחברים את Gmail?</button>
    <button type="button" class="btn" data-mop="replace" hidden>החלפת הטיוטה הקודמת</button>
    <button type="button" class="btn" data-mop="test" title="מייל אמיתי לתיבה שלכם בלבד — לראות אותו כמו שהמאזינים יראו">שליחת בדיקה אליי</button>
    <button type="button" class="btn" data-mop="copy">העתקת המייל</button>
    ${menu('mc-more', 'עוד ▾', 'עוד פעולות', `<button type="button" data-mop="eml">הורדה כקובץ ‎.eml (לאאוטלוק ולתוכנות דואר)</button><button type="button" data-mop="html-file">הורדה כקובץ HTML</button><button type="button" data-mop="copy-html">העתקת קוד ה־HTML</button><button type="button" data-mop="copy-text">העתקת גרסת הטקסט</button><button type="button" data-mop="reset">איפוס העיצוב והניסוח לברירת המחדל</button>`, true)}
    <div class="mc-result" data-m-result role="status" aria-live="polite"></div>
  </div>
</div>`;
      TABS.forEach(([k]) => renderPanel(k));
      paintAll();
    }
    function renderPanel(k) {
      const el = $(`[data-panel="${k}"]`); if (!el || !st.opts) return;
      el.innerHTML = { content: panelContent, design: panelDesign, people: panelPeople, check: panelCheck, history: panelHistory }[k]();
      if (k === 'content') { paintWarn(); paintDescNote(); paintWork(); paintDigestCount(); paintSummaries(); }
      if (k === 'design') { paintTemplates(); paintContrast(); }
      if (k === 'people') paintRecipients(true);
      if (k === 'check') paintChecks();
      if (k === 'history') paintHistory();
    }
    function paintAll() { paintRecipients(true); paintResult(); paintHistory(); preview(true); }

    /* לשונית "תוכן" */
    function panelContent() {
      const o = st.opts, k = st.kind;
      const picker = k === 'episode'
        ? `<label class="field"><span>התוכנית</span><select data-m="ep">${eps().map((x) => `<option value="${esc(x.id)}" ${x.id === st.id ? 'selected' : ''}>${esc(label(x))}${x.date ? ` · ${esc(U.fmtDate(x.date, true))}` : ''}${isLive(x) ? '' : ' (עוד לא באתר)'}</option>`).join('')}</select></label>`
        : k === 'digest'
          ? `<div class="field"><span>התוכניות בסיכום <small data-m-digest-count></small></span>
  <div class="mc-pick-tools"><button type="button" class="btn small" data-mop="digest-latest">3 האחרונות</button><button type="button" class="btn small" data-mop="digest-month">מהחודש האחרון</button><button type="button" class="btn small ghost" data-mop="digest-none">ניקוי</button></div>
  <div class="mc-picks" role="group" aria-label="בחירת התוכניות">${eps().slice(0, 60).map((x) => `<label class="mc-pick${isLive(x) ? '' : ' off'}"><input type="checkbox" data-mpick="${esc(x.id)}" ${st.digest.includes(x.id) ? 'checked' : ''}><span><b>${esc(label(x))}</b><small>${esc([x.number != null ? `תוכנית ${x.number}` : '', x.date ? U.fmtDate(x.date, true) : '', isLive(x) ? '' : 'עוד לא באתר'].filter(Boolean).join(' · '))}</small></span></label>`).join('')}</div></div>`
          : '';
      return `
<section class="mc-sec">
  ${picker}
  ${k !== 'episode' ? `<label class="field"><span>הכותרת הגדולה</span><input data-m="headline" value="${esc(o.headline)}" maxlength="120" autocomplete="off"></label>` : ''}
  <div class="mc-warn" data-m-warn></div>
  <div class="mc-work" data-m-work hidden></div>
</section>

<section class="mc-sec">
  <h3 class="mc-h">נושא ושורת התצוגה</h3>
  <div class="field">
    <label for="mc${uid}-subject"><span>נושא המייל</span></label>
    <div class="mc-input-tools"><input id="mc${uid}-subject" data-m="subject" value="${esc(o.subject)}" maxlength="200" autocomplete="off">${menu('mc-sugg', '✦ הצעות', 'הצעות לנושא', '<div data-m-suggest></div>')}${tokenMenu('subject')}${emojiMenu('subject')}</div>
    <small data-m-subject-len></small>
  </div>
  <label class="field"><span>שורת התצוגה המקדימה (לא חובה)</span><input data-m="preheader" value="${esc(o.preheader)}" maxlength="150" autocomplete="off"><small>המשפט האפור שמופיע בתיבת הדואר אחרי הנושא. ריק — המשפט הראשון של ה${k === 'note' ? 'הודעה' : 'פתיחה'}.</small></label>
</section>

<section class="mc-sec">
  <div class="mc-h-row"><h3 class="mc-h">גוף המייל</h3><small>הסדר כאן הוא הסדר במייל · ↑↓ להזזה · תיבת הסימון מדליקה ומכבה</small></div>
  <ol class="mc-blocks">${blocksHtml()}</ol>
</section>`;
    }
    function blocksHtml() {
      const list = st.opts.blocks.filter((b) => M.BLOCKS[b.id].kinds.includes(st.kind));
      return list.map((b, i) => {
        const body = blockBody(b.id), open = st.expanded.has(b.id), name = blockName(b.id);
        return `<li class="mc-block${b.on ? '' : ' off'}" data-block="${b.id}">
  <div class="mc-block-head">
    <label class="mc-switch"><input type="checkbox" data-mblock="${b.id}" ${b.on ? 'checked' : ''}><span>${esc(name)}</span></label>
    <small class="mc-block-sum" data-m-sum="${b.id}"></small>
    <span class="mc-move"><button type="button" data-mmove="up" data-id="${b.id}" aria-label="להזיז למעלה: ${esc(name)}" ${i ? '' : 'disabled'}>↑</button><button type="button" data-mmove="down" data-id="${b.id}" aria-label="להזיז למטה: ${esc(name)}" ${i < list.length - 1 ? '' : 'disabled'}>↓</button></span>
    ${body ? `<button type="button" class="mc-expand" data-mexpand="${b.id}" aria-expanded="${open}" aria-label="עריכה: ${esc(name)}">▾</button>` : ''}
  </div>
  ${body ? `<div class="mc-block-body" data-mbody="${b.id}" ${open ? '' : 'hidden'}>${body}</div>` : ''}
</li>`;
      }).join('');
    }
    function blockBody(id) {
      const o = st.opts, e = ep(), hasAudio = !!(e && U.downloadUrl(e));
      const field = (key, text, attrs = '') => `<label class="field"><span>${text}</span><input data-m="${key}" value="${esc(o[key])}" ${attrs}></label>`;
      switch (id) {
        case 'intro': return `${ta('intro', st.kind === 'note' ? 7 : 4, st.kind === 'note' ? 'מה רציתם לספר למאזינים?' : 'כמה מילים לפני הכפתורים')}<small class="mc-note">${FORMAT_HINT}${st.kind === 'episode' ? ' כשתעברו לתוכנית אחרת, השם שלה ייכנס במקום השם הזה.' : ''}</small>`;
        case 'buttons': return st.kind === 'episode'
          ? `<div class="form-grid">${field('listenLabel', 'הכפתור הראשי', 'maxlength="40"')}${field('downloadLabel', 'כפתור ההורדה', `maxlength="40" ${hasAudio ? '' : 'disabled'}`)}</div>${check('download', 'כפתור הורדה ישירה (וגם בכרטיסי התוכניות)', hasAudio, 'אין הקלטה')}`
          : `${field('siteLabel', 'הטקסט על הכפתור', 'maxlength="40"')}<small class="mc-note">${st.kind === 'digest' ? 'מוביל לארכיון התוכניות באתר.' : 'מוביל לדף הבית של האתר.'}</small>${st.kind === 'digest' ? check('download', 'קישורי הורדה בכרטיסי התוכניות') : ''}`;
        case 'description': return `<input data-m="descTitle" value="${esc(o.descTitle)}" maxlength="60" placeholder="כותרת לתיאור (לא חובה)" aria-label="הכותרת מעל התיאור">${toolbar('description')}<textarea data-m="description" rows="6" aria-label="תיאור התוכנית" placeholder="כמה משפטים על מה שהיה בתוכנית — מי התארח, על מה דיברו, אילו שירים">${esc(o.description)}</textarea><small class="mc-desc-note"><span data-m-desc-note></span> <button type="button" class="link-btn" data-mop="desc-reset" hidden>חזרה לתיאור מהאתר</button></small>`;
        case 'tracks': { const n = (e?.tracks || []).length; return `${field('tracksTitle', 'הכותרת', 'maxlength="60"')}<small class="mc-note">${n ? `${fmtN(n)} שירים מדף התוכנית, כל אחד עם קישור לרגע שלו בתוכנית.` : 'לתוכנית הזו עוד אין רשימת שירים — מוסיפים אותה באזור הניהול, בעריכת התוכנית.'}</small>`; }
        case 'quote': return `<textarea data-m="quote" rows="2" aria-label="הציטוט" placeholder="משפט אחד שכדאי שיבלוט — מהראיון, מהאורח, או שלכם">${esc(o.quote)}</textarea><input data-m="quoteBy" value="${esc(o.quoteBy)}" maxlength="80" placeholder="מי אמר (לא חובה)" aria-label="מי אמר">`;
        case 'links': return `<small class="mc-note">${e && U.publicLinks(e).length ? 'הקישורים הציבוריים מדף התוכנית (בלי קישורי הדרייב).' : 'לתוכנית הזו אין קישורים ציבוריים — הבלוק לא יופיע.'}</small>`;
        case 'cta': return `<div class="form-grid">${field('ctaLabel', 'הטקסט על הכפתור', 'maxlength="50" placeholder="למשל: להצבעה במצעד"')}${field('ctaUrl', 'הקישור', 'class="ltr" type="url" placeholder="https://…"')}</div><small class="mc-note">נשמר גם למיילים הבאים. ריק — הכפתור לא יופיע.</small>`;
        case 'more': return `<div class="form-grid">${field('moreTitle', 'הכותרת', 'maxlength="60"')}<label class="field"><span>כמה תוכניות</span><select data-m="moreCount">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${o.moreCount === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div><small class="mc-note">התוכניות האחרונות שכבר באתר${st.kind === 'episode' ? ', בלי זו שהמייל עליה' : ''}.</small>`;
        case 'share': return `${field('shareTitle', 'הכותרת', 'maxlength="80"')}<label class="field"><span>הטקסט</span><textarea data-m="shareText" rows="2">${esc(o.shareText)}</textarea></label><small class="mc-note">קישור ${st.kind === 'episode' ? 'לתוכנית' : 'לאתר'} וכפתור לשליחה לחבר במייל.</small>`;
        case 'signature': return ta('signature', 2);
        default: return '';
      }
    }
    function blockSummary(id) {
      const o = st.opts, e = ep(), short = (s, n = 46) => { s = M.plain(String(s || '')).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
      switch (id) {
        case 'intro': return short(o.intro) || 'ריק';
        case 'items': return `${fmtN(st.digest.length)} תוכניות — בוחרים למעלה`;
        case 'buttons': return st.kind === 'episode' ? [o.listenLabel, o.show.download && e && U.downloadUrl(e) ? o.downloadLabel : ''].filter(Boolean).join(' · ') : o.siteLabel;
        case 'description': return !o.description.trim() ? 'ריק — לא יופיע' : o.description === String(e?.description || '') ? 'מהאתר' : 'נערך למייל';
        case 'tracks': { const n = (e?.tracks || []).length; return n ? `${fmtN(n)} שירים` : 'אין שירים לתוכנית'; }
        case 'quote': return short(o.quote, 36) || 'ריק — לא יופיע';
        case 'links': { const n = e ? U.publicLinks(e).length : 0; return n ? `${fmtN(n)} קישורים` : 'אין קישורים'; }
        case 'cta': return o.ctaLabel && o.ctaUrl ? o.ctaLabel : 'ריק — לא יופיע';
        case 'more': return `${o.moreCount} תוכניות`;
        case 'share': return 'שליחה לחבר במייל';
        case 'signature': return short(o.signature.split('\n')[0]) || 'בלי חתימה';
        default: return '';
      }
    }
    function paintSummaries() { $$('[data-m-sum]').forEach((el) => { el.textContent = blockSummary(el.dataset.mSum); }); }

    /* לשונית "עיצוב" */
    function panelDesign() {
      const o = st.opts, e = ep(), hue = ctxFor().hue, pal = M.palette(o, { hue });
      const accentHex = /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent : /^#[0-9a-f]{6}$/i.test(pal.accent) ? pal.accent : '#f0c65a';
      const hasCover = !!(e && (e.cover || e.thumb)), canImg = hasCover || /^https:\/\//i.test(o.image || '');
      return `
<section class="mc-sec">
  <h3 class="mc-h">סגנון</h3>
  <div class="mc-styles" role="radiogroup" aria-label="סגנון המייל">${Object.entries(M.STYLES).map(([k, s]) => { const p = M.palette({ style: k }, { hue }); return `<button type="button" class="mc-style" role="radio" data-mstyle="${k}" aria-checked="${o.style === k}"><span class="mc-swatch" aria-hidden="true"><i style="background:${p.bg}"></i><i style="background:${p.card}"></i><i style="background:${p.accent}"></i></span><b>${esc(s.name)}</b><small>${esc(s.hint)}</small></button>`; }).join('')}</div>
  <div class="mc-row">
    <label class="field mc-color"><span>צבע הכפתורים וההדגשות</span><input type="color" data-m="accent" value="${esc(accentHex)}"></label>
    <button type="button" class="btn small ghost" data-mop="accent-reset" ${o.accent ? '' : 'hidden'}>חזרה לצבע של הסגנון</button>
    <small class="mc-contrast" data-m-contrast></small>
  </div>
</section>

<section class="mc-sec">
  <h3 class="mc-h">גופן וכפתורים</h3>
  <div class="mc-fonts" role="radiogroup" aria-label="הגופן">${Object.entries(M.FONT_SETS).map(([k, f]) => `<button type="button" role="radio" class="mc-font" data-mfont="${k}" aria-checked="${o.font === k}"><b style="font-family:${esc(f.display)}">אבג</b><span>${esc(f.name)}</span><small>${esc(f.hint)}</small></button>`).join('')}</div>
  <div class="field"><span>צורת הכפתורים</span><div class="segmented" role="group" aria-label="צורת הכפתורים">${Object.entries(M.SHAPES).map(([k, s]) => `<button type="button" data-mshape="${k}" aria-pressed="${o.shape === k}">${esc(s.name)}</button>`).join('')}</div></div>
  <small class="mc-note">בג'ימייל הגופנים המיוחדים מוחלפים בגופן רגיל — ובטלפונים של אפל ובאאוטלוק לרוב מוצגים כמו שבחרתם.</small>
</section>

<section class="mc-sec">
  <h3 class="mc-h">תמונה</h3>
  <div class="segmented" role="group" aria-label="מיקום התמונה">${[['head', 'בכותרת'], ['full', 'גדולה לכל הרוחב'], ['none', 'בלי תמונה']].map(([k, t]) => `<button type="button" data-mcover="${k}" aria-pressed="${(canImg ? o.cover : 'none') === k}" ${canImg || k === 'none' ? '' : 'disabled'}>${t}</button>`).join('')}</div>
  <label class="field"><span>תמונה משלכם (קישור https, לא חובה)</span><input data-m="image" value="${esc(o.image)}" class="ltr" type="url" placeholder="https://…/banner.jpg" autocomplete="off"><small>${st.kind === 'episode' ? (hasCover ? 'במקום התמונה של התוכנית.' : 'לתוכנית הזו אין תמונה — אפשר לשים כאן קישור לתמונה.') : 'באנר או לוגו בראש המייל.'}</small></label>
</section>

<section class="mc-sec">
  <h3 class="mc-h">פרטים</h3>
  <div class="mc-checks">
    ${check('guests', 'האורחים ליד הכותרת', st.kind !== 'episode' || !!(e?.guests || []).length, st.kind === 'episode' ? 'אין אורחים' : '')}
    ${check('phone', 'קו הטלפון בתחתית')}
    ${check('unsubscribe', 'שורת הסרה מהרשימה')}
    ${check('tagline', 'שורת הסלוגן מעל המייל')}
  </div>
</section>

<section class="mc-sec">
  <h3 class="mc-h">תבניות שמורות</h3>
  <div data-m-templates></div>
  <div class="mc-tpl-add"><input data-m-tplname maxlength="40" placeholder="שם לתבנית — למשל: חגים" aria-label="שם לתבנית"><button type="button" class="btn small" data-mop="tpl-save">שמירת העיצוב והניסוח כתבנית</button></div>
</section>`;
    }
    function paintTemplates() {
      const box = $('[data-m-templates]'); if (!box) return;
      const list = templates();
      box.innerHTML = list.length
        ? `<ul class="mc-tpls">${list.map((t) => `<li><span><b>${esc(t.name)}</b><small>${esc([M.own(M.KINDS, t.kind) ? M.KINDS[t.kind].name : '', M.own(M.STYLES, t.data.style) ? M.STYLES[t.data.style].name : '', when(t.at)].filter(Boolean).join(' · '))}</small></span><button type="button" class="btn small" data-mtpl="apply" data-name="${esc(t.name)}">החלה</button><button type="button" class="icon-btn del" data-mtpl="del" data-name="${esc(t.name)}" aria-label="מחיקת התבנית ${esc(t.name)}">✕</button></li>`).join('')}</ul>`
        : '<p class="cue-hint">עוד אין תבניות. עצבו מייל ושמרו אותו — לחגים, למהדורות מיוחדות, לסיכום חודשי. התבניות נשמרות בחשבון.</p>';
    }
    function paintContrast() {
      const el = $('[data-m-contrast]'); if (!el) return;
      const p = M.palette(st.opts, { hue: ctxFor().hue }), c = M.contrast(p.accent, p.card);
      el.textContent = c < 1.6 ? 'הצבע קרוב מאוד לרקע — הכפתורים כמעט לא יבלטו.' : c < 3 ? 'קישורים בתוך הטקסט יוצגו בצבע הטקסט, כדי שיהיו קריאים.' : '';
    }

    /* לשונית "נמענים" */
    function panelPeople() {
      return `
<section class="mc-sec">
  <h3 class="mc-h">למי</h3>
  <div class="segmented" role="group" aria-label="נמענים">
    <button type="button" data-mmode="all" aria-pressed="${st.mode === 'all'}">כל רשימת התפוצה</button>
    <button type="button" data-mmode="me" aria-pressed="${st.mode === 'me'}">רק אליי — לבדיקה</button>
  </div>
  <p class="help" data-m-count></p>
  <div class="mc-addrow" data-m-addrow><button type="button" class="btn small" data-mop="add-open">+ הוספת כתובות לרשימה</button></div>
  <details class="mc-list" data-m-listbox>
    <summary>הרשימה — הוספת כתובות, ייבוא מאקסל ועריכה</summary>
    <p class="help mc-list-help">מדביקים כתובות בסוף התיבה (אחת בכל שורה, שורות מאקסל, או "שם &lt;כתובת&gt;") או מייבאים קובץ אקסל / CSV. הן נכנסות לטיוטה הזו — ובלחיצה על "שמירה ברשימת התפוצה" גם לרשימה עצמה, לכל המיילים הבאים.</p>
    <textarea data-m="list" class="ltr" rows="5" spellcheck="false" aria-label="כתובות רשימת התפוצה, אחת בכל שורה"></textarea>
    <div class="actions" style="margin-top:8px">
      <button type="button" class="btn small" data-mop="import">ייבוא מקובץ (אקסל / CSV / טקסט)</button>
      <button type="button" class="btn small" data-mop="reload-list">טעינה מחדש מהשרת</button>
      <button type="button" class="btn small ghost" data-mop="copy-list">העתקת הכתובות</button>
      <input type="file" data-m-file accept=".xlsx,.csv,.txt,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
    </div>
    <div class="mc-save" data-m-save hidden>
      <b data-m-save-text></b>
      <button type="button" class="btn small primary" data-mop="save-list">שמירה ברשימת התפוצה <span>←</span></button>
      <small>הוסיפו רק אנשים שביקשו לקבל את המיילים. מי שהסיר את עצמו בעבר לא יחזור לרשימה.</small>
    </div>
  </details>
  <div class="mc-quality" data-m-quality hidden></div>
  <div class="mc-domains" data-m-domains hidden></div>
  <details class="mc-list" data-m-excludebox>
    <summary>לא לשלוח אל <span data-m-exclude-count></span></summary>
    <p class="help mc-list-help">כתובות שיוצאו מכל הטיוטות — גם אם הן ברשימת התפוצה (למשל חברי הצוות, או מי שביקש הפסקה זמנית). נשמר בחשבון לפעם הבאה.</p>
    <textarea data-m="exclude" class="ltr" rows="3" spellcheck="false" aria-label="כתובות שלא יקבלו את המייל">${esc(st.exclude.join('\n'))}</textarea>
  </details>
</section>

<section class="mc-sec">
  <h3 class="mc-h">השולח והטיוטות</h3>
  <div class="form-grid">
    <label class="field"><span>"אל" — הכתובת שלכם</span><input data-m="to" value="${esc(st.to)}" class="ltr" type="email" autocomplete="off" placeholder="${esc(S.sb.user?.email || '')}"><small>כתובת אחת בלבד. כל רשימת התפוצה נכנסת רק לעותק מוסתר (Bcc) — אף נמען לא רואה את הכתובות של האחרים, וכתובת מהרשימה לא תיכנס ל"אל".</small></label>
    <label class="field"><span>תשובות יגיעו אל (לא חובה)</span><input data-m="replyTo" value="${esc(st.replyTo)}" class="ltr" type="email" placeholder="${esc(st.to)}" autocomplete="off"></label>
    <label class="field"><span>עד כמה נמענים בכל טיוטה</span><input data-m="chunk" type="number" min="1" max="2000" value="${st.chunk}" inputmode="numeric"><small>בג'ימייל רגיל אפשר לשלוח עד 500 נמענים ביום; ברשימה ארוכה יותר נוצרות כמה טיוטות.</small></label>
  </div>
  <p class="help mc-note" data-m-limit></p>
</section>`;
    }

    /* לשוניות "בדיקה" ו"היסטוריה" */
    const panelCheck = () => '<section class="mc-sec"><div class="mc-score" data-m-score></div><ul class="mc-audit" data-m-audit></ul><p class="cue-hint">הבדיקה רצה לבד על כל שינוי. היא לא נוגעת במייל — רק מסמנת מה כדאי לתקן לפני שיוצרים את הטיוטה.</p></section>';
    const panelHistory = () => `<section class="mc-sec">
  <div class="mc-h-row"><h3 class="mc-h">הטיוטות שנוצרו</h3><span class="mc-h-ops"><button type="button" class="btn small" data-mop="hist-check">בדיקת המצב בג'ימייל</button><button type="button" class="btn small ghost" data-mop="hist-clear">ניקוי הרשימה</button></span></div>
  <p class="cue-hint">נשמר בחשבון שלכם. "בדיקת המצב" שואלת את ג'ימייל אילו טיוטות עוד מחכות — טיוטה שנשלחה או נמחקה כבר לא שם.</p>
  <div data-m-history></div>
</section>`;

    /* ---------- ציור החלקים ---------- */

    function paintWarn() {
      const box = $('[data-m-warn]'); if (!box) return;
      const w = [], e = ep();
      if (st.kind === 'episode' && e) {
        if (!isLive(e)) w.push(e.visible ? `התוכנית מתוזמנת ועוד לא באתר${e.publishAt ? ` (תעלה ב־${U.fmtDate(e.publishAt.slice(0, 10), true)} ${e.publishAt.slice(11, 16)})` : ''} — הקישורים יעבדו מאז. אפשר ליצור את הטיוטה עכשיו ולשלוח אחר כך.` : 'התוכנית עוד לא מוצגת באתר — הקישורים יעבדו רק אחרי שתפורסם. אפשר ליצור את הטיוטה עכשיו ולשלוח אחרי הפרסום.');
        if (!U.downloadUrl(e)) w.push('לתוכנית אין הקלטה, ולכן אין כפתור הורדה.');
      }
      if (st.kind === 'digest') {
        const off = digestEps().filter((x) => !isLive(x)).length;
        if (off) w.push(`${off === 1 ? 'תוכנית אחת' : `${fmtN(off)} תוכניות`} שבחרתם עוד לא באתר — הקישורים שלהן יעבדו רק אחרי הפרסום.`);
      }
      const prev = st.history.find((h) => h.key === keyFor() && h.mode !== 'me');
      if (prev) w.push(`כבר יצרתם טיוטה ${st.kind === 'episode' ? 'לתוכנית הזו' : 'למייל כזה'} (${when(prev.at)}) — לחיצה נוספת תיצור עוד אחת${prevFor(keyFor()) ? ', או "החלפת הטיוטה הקודמת"' : ''}.`);
      box.innerHTML = w.map((t) => `<p>${esc(t)}</p>`).join('');
    }
    function paintWork() {
      const box = $('[data-m-work]'); if (!box) return;
      box.hidden = !st.restored;
      box.innerHTML = st.restored ? `<span>ממשיכים מאיפה שעצרתם — הנוסח שכתבתם למייל הזה נשמר${st.restored > 1 ? ` (${esc(when(st.restored))})` : ''}.</span> <button type="button" class="link-btn" data-mop="work-reset">להתחיל מחדש</button>` : '';
    }
    function paintDigestCount() {
      const el = $('[data-m-digest-count]'); if (el) el.textContent = st.digest.length ? `· נבחרו ${fmtN(st.digest.length)}` : '· לא נבחרו';
    }
    function paintDescNote() {
      const e = ep(), note = $('[data-m-desc-note]'), back = $('[data-mop="desc-reset"]'); if (!e || !note) return;
      const same = st.opts.description === String(e.description || '');
      note.textContent = same ? (st.opts.description.trim() ? 'מתוך דף התוכנית באתר. שינוי כאן משנה רק את המייל.' : 'לתוכנית אין עדיין תיאור באתר — אפשר לכתוב כאן תיאור למייל.') : 'נערך למייל הזה (באתר נשאר התיאור המקורי).';
      if (back) back.hidden = same;
      // כותבים תיאור בזמן שהבלוק כבוי — מדליקים אותו
      const blk = st.opts.blocks.find((b) => b.id === 'description');
      if (blk && !same && st.opts.description.trim() && !blk.on) { blk.on = true; const box = $('[data-mblock="description"]'); if (box) { box.checked = true; box.closest('.mc-block')?.classList.remove('off'); } }
    }

    function paintRecipients(fillBox) {
      const r = st.rcp, count = $('[data-m-count]'), taEl = $('[data-m="list"]');
      const list = effective(), n = list.length, ex = r.list.length - n, drafts = Math.max(1, Math.ceil(n / perDraft(st.chunk, limit())));
      st.quality = M.checkAddresses(st.mode === 'me' ? [] : list);
      if (count) {
        if (st.mode === 'me') count.textContent = 'טיוטת בדיקה אליכם בלבד — בלי הרשימה. ככה רואים איך המייל נראה באמת לפני שיוצרים את הטיוטה לכולם.';
        else if (r.state === 'loading') count.innerHTML = '<span class="notice-spinner" aria-hidden="true"></span> טוענים את רשימת התפוצה…';
        else if (!r.list.length) count.innerHTML = `<span class="problems">${esc(r.state === 'missing' ? 'השרת עוד לא מחזיר את רשימת התפוצה (צריך לעדכן אותו). בינתיים: הורידו את הרשימה מניהול הסקר ("רשימת תפוצה" ← הורדה) וייבאו את הקובץ כאן, או הדביקו כתובות.' : r.state === 'error' ? `הרשימה לא נטענה: ${r.error}` : 'אין כתובות ברשימה. הדביקו כתובות או ייבאו קובץ.')}</span>`;
        else count.textContent = `${fmtN(n)} כתובות${r.source === 'manual' ? ' (רשימה שערכתם כאן)' : ' מרשימת התפוצה'} ייכנסו בעותק מוסתר (Bcc) בלבד${ex ? ` — ${fmtN(ex)} הוצאו ("לא לשלוח אל")` : ''}${drafts > 1 ? ` — ${drafts} טיוטות, עד ${fmtN(perDraft(st.chunk, limit()))} נמענים בכל אחת` : ''}.`;
      }
      if (taEl && fillBox) taEl.value = r.list.join('\n');
      const box = $('[data-m-listbox]'); if (box && st.mode === 'all' && !r.list.length && r.state !== 'loading') box.open = true;
      const addrow = $('[data-m-addrow]'); if (addrow) addrow.hidden = st.mode === 'me';
      // כתובות שנוספו כאן ועוד אינן ברשימת התפוצה בשרת — אפשר לשמור אותן בה
      const fresh = st.serverOk ? r.list.filter((e) => !st.server.has(e)) : [];
      const saveBox = $('[data-m-save]'); if (saveBox) saveBox.hidden = st.mode === 'me' || !fresh.length;
      const saveText = $('[data-m-save-text]'); if (saveText) saveText.textContent = fresh.length === 1 ? 'כתובת אחת חדשה שעוד אינה ברשימת התפוצה' : `${fmtN(fresh.length)} כתובות חדשות שעוד אינן ברשימת התפוצה`;
      // טעויות הקלדה, וכתובות שלא מקבלות דואר
      const q = st.quality, qb = $('[data-m-quality]');
      if (qb) {
        qb.hidden = !(q.typos.length || q.risky.length);
        qb.innerHTML = `${q.typos.length ? `<div class="mc-q"><b>${q.typos.length === 1 ? 'כתובת אחת נראית שגויה' : `${fmtN(q.typos.length)} כתובות נראות שגויות`}</b><ul>${q.typos.slice(0, 8).map((t) => `<li><span class="ltr">${esc(t.email)}</span> ← <span class="ltr">${esc(t.fix)}</span> <button type="button" class="link-btn" data-mfix="${esc(t.email)}">תיקון</button></li>`).join('')}</ul>${q.typos.length > 1 ? `<button type="button" class="btn small" data-mop="fix-all">תיקון ${q.typos.length > 8 ? `כל ה־${fmtN(q.typos.length)}` : 'כולן'}</button>` : ''}</div>` : ''}${q.risky.length ? `<div class="mc-q"><b>${q.risky.length === 1 ? 'כתובת אחת לא מקבלת מיילים' : `${fmtN(q.risky.length)} כתובות לא מקבלות מיילים`}</b> <span class="ltr">${esc(q.risky.slice(0, 4).join(', '))}${q.risky.length > 4 ? '…' : ''}</span> <button type="button" class="link-btn" data-mop="drop-risky">להוציא ("לא לשלוח אל")</button></div>` : ''}`;
      }
      const db = $('[data-m-domains]');
      if (db) { db.hidden = st.mode === 'me' || n < 2; db.innerHTML = q.domains.slice(0, 6).map(([d, c]) => `<span class="chip"><span class="ltr">${esc(d)}</span> · ${fmtN(c)}</span>`).join(''); }
      const exc = $('[data-m-exclude-count]'); if (exc) exc.textContent = st.exclude.length ? `(${fmtN(st.exclude.length)})` : '';
      const lim = $('[data-m-limit]');
      if (lim) { const L = limit(); lim.textContent = `${st.account || S.sb.user?.email ? `החשבון ${st.account || S.sb.user.email}: ` : ''}עד ${fmtN(L)} נמענים ביום בג'ימייל${L === 500 ? ' (חשבון רגיל; ב־Google Workspace עד 2,000)' : ' (Google Workspace)'}.${st.mode === 'all' && n > L ? ` ברשימה הזו ${fmtN(n)} — הטיוטות יסומנו לפי ימים: שולחים טיוטה אחת ביום.` : ''}`; }
      const empty = st.mode === 'all' && !n && r.state !== 'loading';
      const badge = $('[data-mbadge="people"]'); if (badge) { badge.textContent = st.mode === 'me' ? 'בדיקה' : empty ? '!' : n ? fmtN(n) : ''; badge.className = `mc-badge${empty ? ' err' : q.typos.length ? ' warn' : ''}`; }
    }
    /** זוכרים מאיזו שורה הגיעה כל כתובת — כדי שהשם שלידה יישמר ברשימה */
    function rememberLines(text) {
      for (const raw of String(text || '').split(/\r?\n/)) { const line = M.unmark(raw).trim(); for (const e of M.parseEmails(line)) if (!st.lines.has(e) || line.length > st.lines.get(e).length) st.lines.set(e, line); }
    }
    /** השורה (עם השם) שנשלחת לרשימה — רק אם יש בה בדיוק את הכתובת הזו. בשורה עם כמה כתובות, או
        שהכתובת שבה נמחקה או תוקנה, נשלחת הכתובת לבד: לרשימה נכנס בדיוק מה שרואים כאן. */
    const lineFor = (e) => { const l = st.lines.get(e), got = l ? M.parseEmails(l) : []; return got.length === 1 && got[0] === e ? l : e; };
    function setList(list) { st.rcp = { ...st.rcp, state: 'ready', list: [...new Set(list)], error: '', source: 'manual' }; st.error = ''; paintRecipients(true); paintResult(); paintChecks(); }
    function fixAddresses(emails) {
      const fixes = new Map(st.quality.typos.filter((t) => emails.includes(t.email)).map((t) => [t.email, t.fix]));
      // בשורה המקורית הכתובת יכולה להיות באותיות גדולות (David@Gmial.com) — מחליפים בלי תלות באותיות
      for (const [from, to] of fixes) if (st.lines.has(from)) st.lines.set(to, st.lines.get(from).replace(new RegExp(escRe(from), 'gi'), to));
      setList(st.rcp.list.map((a) => fixes.get(a) || a));
      U.notify(fixes.size === 1 ? 'הכתובת תוקנה בטיוטה הזו.' : `${fmtN(fixes.size)} כתובות תוקנו בטיוטה הזו.`, 'success');
    }
    /** שומרים ברשימת התפוצה בשרת את הכתובות החדשות, וטוענים את הרשימה מחדש */
    async function saveToList(btn) {
      const fresh = st.rcp.list.filter((e) => !st.server.has(e)); if (!fresh.length) return;
      btn.disabled = true;
      try {
        const r = await S.sb.subscribe.add(fresh.map(lineFor).join('\n'));
        const added = Number(r.added) || 0, gone = Number(r.optedOut) || 0;
        U.notify(`${added ? (added === 1 ? 'כתובת אחת נוספה' : `${fmtN(added)} כתובות נוספו`) + ' לרשימת התפוצה' : 'לא נוספו כתובות חדשות'}${gone ? ` · ${fmtN(gone)} הסירו את עצמם בעבר ולא נוספו` : ''}.`, added ? 'success' : 'info', { ttl: 8000 });
        await loadRecipients();
      } catch (err) { U.notify(`השמירה ברשימה לא הצליחה: ${err.message}`, 'error'); }
      finally { btn.disabled = false; }   // הכפתור נשאר — כתובות שיתווספו אחר כך באותו ביקור נשמרות גם הן
    }
    async function loadRecipients() {
      st.rcp = { state: 'loading', list: [], error: '', source: '' }; paintRecipients(true);
      try {
        const r = await S.sb.subscribe.list();
        st.rcp = { state: 'ready', list: M.parseEmails((r.subscribers || []).map((x) => (typeof x === 'string' ? x : x?.email)).join('\n')), error: '', source: 'server' };
        st.server = new Set(st.rcp.list); st.serverOk = true;
      } catch (err) { st.rcp = { state: err.status === 404 ? 'missing' : 'error', list: [], error: err.message, source: '' }; st.serverOk = false; }
      paintRecipients(true); paintChecks();
    }

    function paintChecks() {
      const b = st.last; if (!b) return;
      const list = M.audit(b, auditInfo());
      const errors = list.filter((x) => x.level === 'error').length, warns = list.filter((x) => x.level === 'warn').length;
      const badge = $('[data-mbadge="check"]');
      if (badge) { badge.textContent = errors ? fmtN(errors) : warns ? fmtN(warns) : '✓'; badge.className = `mc-badge ${errors ? 'err' : warns ? 'warn' : 'ok'}`; }
      const score = $('[data-m-score]');
      if (score) score.innerHTML = `<b class="${errors ? 'err' : warns ? 'warn' : 'ok'}">${errors ? `✕ ${errors === 1 ? 'דבר אחד לתקן' : `${fmtN(errors)} דברים לתקן`} לפני היצירה` : warns ? `✓ אפשר ליצור — עם ${warns === 1 ? 'הערה אחת' : `${fmtN(warns)} הערות`}` : '✓ הכל מוכן ליצירה'}</b>`;
      const ul = $('[data-m-audit]');
      if (ul) ul.innerHTML = list.map((x) => `<li class="lv-${x.level}"><i aria-hidden="true">${{ error: '✕', warn: '!', info: 'i', ok: '✓' }[x.level]}</i><span>${esc(x.text)}</span>${x.fix ? `<button type="button" class="link-btn" data-mgo="${x.fix}">לתיקון ←</button>` : ''}</li>`).join('');
      const meter = $('[data-m-meter]');
      if (meter) {
        const pct = Math.min(100, Math.round((b.size / (102 * 1024)) * 100)), min = Math.max(1, Math.round(b.report.words / 200));
        meter.innerHTML = `<span class="mc-bar${pct > 78 ? ' hot' : ''}" title="גודל המייל מתוך 102 KB — מעבר לזה ג'ימייל מקצר"><i style="width:${Math.max(2, pct)}%"></i></span><small>${fmtN(Math.max(1, Math.round(b.size / 1024)))} KB מתוך 102 · ${min === 1 ? 'כדקת קריאה' : `כ־${min} דקות קריאה`}</small><button type="button" class="mc-status ${errors ? 'err' : warns ? 'warn' : 'ok'}" data-mgo="check">${errors ? `✕ ${fmtN(errors)} לתיקון` : warns ? `! ${fmtN(warns)} הערות` : '✓ מוכן'}</button>`;
      }
    }

    function paintHistory() {
      const open = st.history.filter((h) => h.mode !== 'me' && !DONE.has(h.state)).length;
      const badge = $('[data-mbadge="history"]'); if (badge) { badge.textContent = open ? fmtN(open) : ''; badge.className = 'mc-badge'; }
      const box = $('[data-m-history]'); if (!box) return;
      syncHistory();
      const chk = $('[data-mop="hist-check"]'); if (chk) { chk.disabled = st.checking || !st.history.length; chk.innerHTML = st.checking ? '<span class="notice-spinner" aria-hidden="true"></span> בודקים…' : 'בדיקת המצב בג\'ימייל'; }
      if (!st.history.length) { box.innerHTML = '<p class="cue-hint">עוד לא נוצרו טיוטות מכאן.</p>'; return; }
      box.innerHTML = st.history.map((h) => {
        const [text, tone] = STATE[h.state] || ['לא נבדק', 'navy'];
        const partial = h.state === 'open' && h.alive && h.alive < h.drafts.length ? ` (${fmtN(h.alive)} מתוך ${fmtN(h.drafts.length)})` : '';
        const cur = h.key === keyFor();
        return `<article class="mc-hist${DONE.has(h.state) ? ' done' : ''}${cur ? ' cur' : ''}">
  <div class="mc-hist-head"><b>${esc(h.title || h.subject || '')}</b><span class="pill ${tone}">${esc(text + partial)}</span></div>
  <small>${esc([M.KINDS[h.kind]?.name, when(h.at), h.email, h.mode === 'me' ? 'בדיקה אליי' : `${fmtN(h.total)} נמענים`, h.drafts.length > 1 ? `${fmtN(h.drafts.length)} טיוטות` : ''].filter(Boolean).join(' · '))}</small>
  ${h.subject ? `<small class="mc-hist-subj">${esc(h.subject)}</small>` : ''}
  <div class="mc-hist-ops">${DONE.has(h.state) ? '' : h.drafts.map((d, j) => `<a class="btn small" href="${esc(draftUrl(h.email, d.messageId))}" target="_blank" rel="noopener">${h.drafts.length > 1 ? `טיוטה ${j + 1}${d.day > 1 ? ` · יום ${d.day}` : ''}` : 'פתיחה בג\'ימייל'} ←</a>`).join('')}${cur ? '' : `<button type="button" class="btn small ghost" data-mhist="load" data-id="${esc(hid(h))}">לעריכה כאן</button>`}${DONE.has(h.state) ? '' : `<button type="button" class="btn small danger" data-mhist="delete" data-id="${esc(hid(h))}">מחיקה מג'ימייל</button>`}<button type="button" class="icon-btn" data-mhist="forget" data-id="${esc(hid(h))}" aria-label="הסרה מהרשימה">✕</button></div>
</article>`;
      }).join('');
    }

    let previewTimer = 0;
    function preview(now) {
      clearTimeout(previewTimer);
      const run = () => {
        const b = built(); st.last = b; if (!b) return;
        const f = $('[data-m-frame]'), pre = $('[data-m-text]');
        if (f && st.view !== 'text') { f.onload = () => { try { f.style.height = `${Math.max(420, f.contentDocument.documentElement.scrollHeight + 4)}px`; } catch { /* */ } }; f.srcdoc = b.html; }
        if (pre) pre.textContent = b.text;
        const s = $('[data-m-inbox-subject]'), p = $('[data-m-inbox-pre]'), len = $('[data-m-subject-len]'), ph = $('[data-m="preheader"]');
        if (s) s.textContent = b.subject; if (p) p.textContent = b.preheader;
        if (len) len.textContent = `${b.subject.length} תווים${b.subject.length > 70 ? ' — בטלפון רואים רק את ההתחלה.' : b.subject.length > 40 ? ' · בטלפון רואים כ־40 הראשונים' : ''}`;
        if (ph) ph.placeholder = b.report.preheaderAuto ? b.preheader : '';
        paintChecks(); paintSummaries();
      };
      if (now) run(); else previewTimer = setTimeout(run, 160);
    }
    function paintResult() {
      const box = $('[data-m-result]'), btn = $('[data-mop="create"]'), rep = $('[data-mop="replace"]'), test = $('[data-mop="test"]'); if (!box) return;
      const key = keyFor(), made = st.history.some((h) => h.key === key), prev = prevFor(key);
      if (btn) { btn.disabled = st.busy; btn.innerHTML = st.busy ? '<span class="notice-spinner" aria-hidden="true"></span> יוצרים…' : `${made ? 'יצירת טיוטה נוספת' : 'יצירת טיוטה בג\'ימייל'} <span>←</span>`; }
      if (rep) { rep.hidden = !prev || st.mode === 'me'; rep.disabled = st.busy; }
      if (test) test.disabled = st.busy;
      if (st.busy) { box.innerHTML = st.progress ? `<span class="cue-hint">${esc(st.progress)}</span>` : ''; return; }
      if (st.error) { box.innerHTML = `<p class="problems">${esc(st.error)}${st.errorForce ? ' <button type="button" class="link-btn" data-mgo="check">לבדיקה</button> · <button type="button" class="link-btn" data-mop="create-anyway">ליצור בכל זאת</button>' : ''}</p>`; return; }
      const last = st.lastResult && st.lastResult.key === key ? st.lastResult : null;
      if (!last) { box.innerHTML = ''; return; }
      const days = Math.max(...last.drafts.map((d) => d.day || 1));
      box.innerHTML = `<div class="mc-done"><b>✓ ${last.drafts.length === 1 ? 'הטיוטה מחכה' : `${last.drafts.length} טיוטות מחכות`} בג'ימייל של ${esc(last.email)}</b>
<span>${last.mode === 'me' ? 'טיוטת בדיקה אליכם בלבד.' : `${fmtN(last.total)} נמענים — כולם בעותק מוסתר (Bcc). ב"אל" רק ${esc(last.to)}.`} אפשר לערוך אותה שם, ואז "שליחה".${days > 1 ? ` יותר מהמגבלה היומית — שלחו טיוטה אחת ביום (${days} ימים).` : ''}</span>
<span class="mc-done-links">${last.drafts.map((d, i) => `<a class="btn small gold" href="${esc(draftUrl(last.email, d.messageId))}" target="_blank" rel="noopener">${last.drafts.length > 1 ? `טיוטה ${i + 1} (${d.count})${days > 1 ? ` · יום ${d.day}` : ''}` : 'פתיחת הטיוטה'} ←</a>`).join('')}<a class="btn small ghost" href="${esc(`${inbox(last.email)}#drafts`)}" target="_blank" rel="noopener">כל הטיוטות</a></span>
<small class="mc-tip">טיפ: בג'ימייל אפשר גם לתזמן — החץ שליד "שליחה" ← "תזמון שליחה".</small></div>`;
    }

    /* ---------- ג'ימייל: יצירה, החלפה, בדיקה, מחיקה ---------- */

    async function account() {
      if (st.account && st.accountToken === auth.token) return st.account;
      st.account = (await gmail('/profile')).emailAddress || S.sb.user?.email || ''; st.accountToken = auth.token;
      return st.account;
    }
    const titleOf = (b) => (st.kind === 'episode' ? label(ep()) : b.subject);
    async function removeDrafts(h, state) {
      for (const d of h.drafts) {
        try { await gmail(`/drafts/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); }
        catch (err) { if (err.status !== 404) throw err; }
      }
      h.state = state; saveHistory();
    }
    async function create({ replace = false, force = false } = {}) {
      if (st.busy) return;
      if (needsIntro()) { authIntro(() => create({ replace, force })); return; }
      const b = built(); if (!b) return;
      const key = keyFor(), list = st.mode === 'me' ? [] : effective();
      if (st.mode === 'all' && !list.length) { st.error = 'אין כתובות ברשימה — ייבאו קובץ או הדביקו כתובות, או בחרו "רק אליי".'; st.errorForce = false; paintResult(); return; }
      const blocking = M.audit(b, auditInfo()).filter((x) => x.level === 'error' && x.id !== 'recipients');
      if (blocking.length && !force) { st.error = `לפני היצירה כדאי לתקן: ${blocking.map((x) => x.text).join(' · ')}`; st.errorForce = true; st.errorReplace = replace; paintResult(); return; }
      // מה שהטיוטה עליה — נקבע ברגע הלחיצה (בזמן שמחכים לג'ימייל אפשר להמשיך לעבור בעורך)
      const kind = st.kind, mode = st.mode, title = titleOf(b), size = st.chunk;
      const unsubscribe = st.opts.show.unsubscribe ? ctxFor().unsubscribeUrl : '';
      const replyTo = M.parseEmails(st.replyTo)[0] || '';
      /* כל רשימת התפוצה רק בעותק מוסתר (Bcc). ב"אל" יש כתובת אחת בלבד — שלכם — ואף פעם לא כתובת מהרשימה:
         כתובת מהרשימה שהוקלדה שם יורדת ממנו (היא כבר בעותק המוסתר), וכתובות נוספות שהוקלדו עוברות לעותק המוסתר. */
      const inList = new Set(list);
      const typed = M.parseEmails(st.to).filter((a) => !inList.has(a) && !st.exclude.includes(a));
      const extra = typed.slice(1);
      const tokenP = getToken();   // מיד, בתוך הלחיצה
      st.busy = true; st.error = ''; st.errorForce = false; st.progress = 'מחכים לאישור של Google…'; paintResult();
      // מה שכבר נוצר בג'ימייל — נרשם בהיסטוריה גם אם ג'ימייל נכשל באמצע (אחרת הטיוטות שנוצרו "נעלמות" מכאן)
      const drafts = []; let email = '', to = [], planned = 0, recorded = false;
      const record = (extraFields = {}) => {
        const entry = { at: Date.now(), key, kind, title, subject: b.subject, email, to: to[0] || '', mode, total: drafts.reduce((n, d) => n + d.count, 0), drafts, state: 'open', ...extraFields };
        st.history.unshift(entry); saveHistory(); recorded = true;
        return entry;
      };
      try {
        await tokenP;
        st.progress = 'יוצרים את הטיוטה…'; paintResult();
        email = await account();
        const L = M.dailyLimit(email);
        to = mode === 'me' ? [email] : [typed[0] || email].filter(Boolean);
        // כתובות נוספות שהוקלדו נכנסות לרשימה לפני החלוקה — כך גם הן נספרות. כל טיוטה (עם מי שב"אל") עד
        // המגבלה היומית ועד 500 נמענים — אחרת ג'ימייל לא ישלח אותה
        const bccAll = mode === 'me' ? [] : [...new Set([...list.filter((a) => !to.includes(a)), ...extra])];
        const groups = mode === 'me' ? [[]] : M.chunk(bccAll, perDraft(size, L, to.length));
        if (!groups.length) groups.push([]);   // הרשימה היא רק הכתובת שב"אל"
        planned = groups.length;
        let day = 1, used = 0;
        for (let i = 0; i < groups.length; i++) {
          if (groups.length > 1) { st.progress = `יוצרים טיוטה ${i + 1} מתוך ${groups.length}…`; paintResult(); }
          const raw = M.raw({ to, bcc: groups[i], replyTo, subject: b.subject, html: b.html, text: b.text, unsubscribe });
          const d = await gmail('/drafts', { method: 'POST', body: { message: { raw } } });
          const n = groups[i].length + to.length;   // גם מי שב"אל" נספר במגבלה היומית
          if (used && used + n > L) { day++; used = 0; }
          used += n;
          drafts.push({ id: d.id, messageId: d.message?.id || '', count: groups[i].length, day });
        }
        syncHistory();
        const prev = replace ? st.history.find((h) => h.key === key && h.email === email && h.mode !== 'me' && !DONE.has(h.state)) : null;
        st.lastResult = record();
        if (prev) { st.progress = 'מוחקים את הטיוטה הקודמת…'; paintResult(); await removeDrafts(prev, 'replaced'); }
        U.notify(`${drafts.length === 1 ? 'הטיוטה נוצרה' : `${drafts.length} טיוטות נוצרו`} בג'ימייל של ${email}${prev ? ' — והקודמת נמחקה' : ''}.`, 'success');
        if (email && S.sb.user?.email && email.toLowerCase() !== S.sb.user.email.toLowerCase()) U.notify(`שימו לב: הטיוטה נוצרה בחשבון ${email}, לא ב־${S.sb.user.email}.`, 'info');
      } catch (err) {
        st.error = err.message;
        if (drafts.length && !recorded) {
          // נכשל באמצע: מה שנוצר נשמר בהיסטוריה (פתיחה ומחיקה משם), ו"החלפת הטיוטה הקודמת" יוצרת הכל מחדש ומוחקת אותן — בלי כפילויות
          syncHistory(); record({ partial: true });
          st.error = `${err.message} נוצרו ${fmtN(drafts.length)} מתוך ${fmtN(planned)} טיוטות — הן בלשונית "היסטוריה". כדי לא לשלוח פעמיים, לחצו "החלפת הטיוטה הקודמת": כל הטיוטות ייווצרו מחדש, ואלה יימחקו.`;
        }
      }
      finally { st.busy = false; st.progress = ''; paintResult(); paintWarn(); paintHistory(); paintRecipients(false); }
    }
    /** מייל אמיתי — רק לתיבה של החשבון המחובר, כדי לראות אותו בדיוק כמו שהמאזינים יראו */
    async function sendTest() {
      if (st.busy) return;
      if (needsIntro()) { authIntro(sendTest); return; }
      const b = built(); if (!b) return;
      const tokenP = getToken();
      st.busy = true; st.error = ''; st.errorForce = false; st.progress = 'שולחים מייל בדיקה אליכם…'; paintResult();
      try {
        await tokenP;
        const email = await account();
        await gmail('/messages/send', { method: 'POST', body: { raw: M.raw({ to: [email], subject: `[בדיקה] ${b.subject}`, html: b.html, text: b.text }) } });
        U.notify(`מייל בדיקה נשלח אל ${email} — רק אליכם. בדקו אותו בתיבה (גם בטלפון).`, 'success', { ttl: 8000 });
      } catch (err) { st.error = err.message; }
      finally { st.busy = false; st.progress = ''; paintResult(); }
    }
    async function checkHistory(interactive) {
      if (st.checking || !st.history.length || (!interactive && !hasToken())) return;
      const tokenP = getToken();
      st.checking = true; paintHistory();
      try {
        await tokenP;
        const email = await account();
        for (const h of st.history.slice(0, 15)) {
          if (h.email !== email || DONE.has(h.state)) continue;
          let alive = 0;
          for (const d of h.drafts) {
            try { const r = await gmail(`/drafts/${encodeURIComponent(d.id)}?format=minimal`); alive++; if (r.message?.id) d.messageId = r.message.id; }   // עריכה בג'ימייל מחליפה את מזהה ההודעה
            catch (err) { if (err.status !== 404) throw err; }
          }
          h.state = alive ? 'open' : 'gone'; h.alive = alive; h.checkedAt = Date.now();
        }
        saveHistory();
      } catch (err) { if (interactive) U.notify(err.message, 'error'); }
      finally { st.checking = false; paintHistory(); paintResult(); paintWarn(); }
    }
    async function historyOp(op, id) {
      const h = st.history.find((x) => hid(x) === id); if (!h) return;
      if (op === 'forget') { forgotten.add(id); st.history = st.history.filter((x) => x !== h); saveHistory(); paintHistory(); paintResult(); paintWarn(); return; }
      if (op === 'load') {
        const [kind, id] = h.key.startsWith('ep:') ? ['episode', h.key.slice(3)] : [h.key, ''];
        if (kind === 'episode' && !eps().some((e) => e.id === id)) { U.notify('התוכנית הזו כבר לא ברשימה.', 'error'); return; }
        if (kind !== st.kind) setKind(kind);
        if (kind === 'episode' && id !== st.id) pick(id);
        showTab('content'); return;
      }
      if (op === 'delete') {
        if (!confirm(`למחוק מג'ימייל ${h.drafts.length === 1 ? 'את הטיוטה' : `את ${h.drafts.length} הטיוטות`} של "${h.title || h.subject}"? מייל שכבר נשלח לא נפגע.`)) return;
        const tokenP = getToken();
        try {
          await tokenP;
          const email = await account();
          if (email !== h.email) throw new Error(`הטיוטה נמצאת בחשבון ${h.email}, וג'ימייל מחובר עכשיו ל־${email}.`);
          await removeDrafts(h, 'deleted');
          U.notify('הטיוטה נמחקה מג\'ימייל.', 'success');
        } catch (err) { U.notify(err.message, 'error'); }
        paintHistory(); paintResult(); paintWarn();
      }
    }

    /* ---------- העתקה והורדה ---------- */

    async function copyMail() {
      const b = built(); if (!b) return;
      try {
        if (window.ClipboardItem && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([b.bodyHtml], { type: 'text/html' }), 'text/plain': new Blob([b.text], { type: 'text/plain' }) })]);
        } else if (!await U.copy(b.text)) throw new Error('copy');
        U.notify('המייל הועתק. פתחו הודעה חדשה בג\'ימייל והדביקו (Ctrl+V). את הנושא כתבו בשדה הנושא.', 'success', { ttl: 9000 });
      } catch { U.notify('ההעתקה לא הצליחה.', 'error'); }
    }
    const fileName = (ext) => `${String(st.kind === 'episode' ? label(ep()) : st.last?.subject || 'מייל').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'mail'}.${ext}`;
    function download(name, type, content) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    function downloadEml() {
      const b = built(); if (!b) return;
      const list = st.mode === 'me' ? [] : effective(), inList = new Set(list);
      const to = M.parseEmails(st.to).filter((a) => !inList.has(a)).slice(0, 1);
      download(fileName('eml'), 'message/rfc822', M.mime({ to: to.length ? to : [S.sb.user?.email].filter(Boolean), bcc: list, replyTo: M.parseEmails(st.replyTo)[0] || '', subject: b.subject, html: b.html, text: b.text, unsubscribe: st.opts.show.unsubscribe ? ctxFor().unsubscribeUrl : '', unsent: true }));
      U.notify(`הקובץ ירד${list.length ? ` (עם ${fmtN(list.length)} נמענים בעותק מוסתר)` : ''}. פותחים אותו באאוטלוק או ב־Apple Mail — הוא נפתח כהודעה חדשה, מוכנה לשליחה.`, 'success', { ttl: 9000 });
    }

    /* ---------- עריכת טקסט: עיצוב, משתנים, אימוג'י ---------- */

    let lastField = '';   // השדה האחרון שהסמן היה בו — משתנה או אימוג'י נכנסים במקום הסמן, ובשדה אחר בסוף
    root.addEventListener('focusin', (ev) => { if (ev.target.dataset?.m) lastField = ev.target.dataset.m; });
    function insertAt(key, text) {
      const el = $(`[data-m="${key}"]`); if (!el) return;
      const here = lastField === key, a = here ? el.selectionStart ?? el.value.length : el.value.length, z = here ? el.selectionEnd ?? a : a;
      el.setRangeText(text, a, z, 'end'); el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function format(key, how) {
      const el = $(`[data-m="${key}"]`); if (!el) return;
      const a = el.selectionStart, z = el.selectionEnd, v = el.value, sel = v.slice(a, z);
      if (how === 'ul' || how === 'ol') {
        const ls = v.lastIndexOf('\n', a - 1) + 1, i = v.indexOf('\n', Math.max(z - (z > a && v[z - 1] === '\n' ? 1 : 0), a)), le = i < 0 ? v.length : i;
        const lines = v.slice(ls, le).split('\n').map((l, n) => `${how === 'ol' ? `${n + 1}. ` : '- '}${l.replace(/^\s*(?:[-•*]|\d{1,3}[.)])\s+/, '')}`);
        el.setRangeText(lines.join('\n'), ls, le, 'select');
      } else if (how === 'link') {
        const url = (prompt('הכתובת של הקישור:', 'https://') || '').trim();
        if (!url || url === 'https://') return;
        if (!/^(https?:\/\/|mailto:|tel:)\S+$/i.test(url)) { U.notify('הקישור צריך להתחיל ב־https://', 'error'); return; }
        const text = sel.trim() || 'טקסט הקישור';
        el.setRangeText(`[${text}](${url})`, a, z, 'end');
        el.setSelectionRange(a + 1, a + 1 + text.length);
      } else {
        const m = how === 'bold' ? '**' : '*', inner = sel || (how === 'bold' ? 'טקסט מודגש' : 'טקסט נטוי');
        el.setRangeText(`${m}${inner}${m}`, a, z, 'end');
        el.setSelectionRange(a + m.length, a + m.length + inner.length);
      }
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function move(id, dir) {
      const all = st.opts.blocks, vis = all.filter((b) => M.BLOCKS[b.id].kinds.includes(st.kind));
      const i = vis.findIndex((b) => b.id === id), j = dir === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= vis.length) return;
      const a = all.indexOf(vis[i]), c = all.indexOf(vis[j]);
      [all[a], all[c]] = [all[c], all[a]];
      const ol = $('.mc-blocks'); if (ol) ol.innerHTML = blocksHtml();
      paintDescNote(); paintSummaries(); save(); preview();
      const btn = $(`[data-mmove="${dir}"][data-id="${id}"]`);
      (btn && !btn.disabled ? btn : $(`[data-mmove="${dir === 'up' ? 'down' : 'up'}"][data-id="${id}"]`))?.focus();
    }
    function showTab(k) {
      if (!TABS.some(([t]) => t === k)) return;
      st.tab = k;
      $$('[role="tab"][data-mtab]').forEach((b) => { const on = b.dataset.mtab === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== k; });
      $$('[data-mstep]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mstep === k)));
      if (k === 'history') checkHistory(false);
      if (k === 'check') paintChecks();
    }
    function closeMenus(except) { $$('details.mc-menu[open]').forEach((d) => { if (d !== except) d.open = false; }); }

    /* ---------- תבניות ---------- */

    function saveTemplate() {
      const input = $('[data-m-tplname]'), name = (input?.value || '').trim();
      if (!name) { input?.focus(); U.notify('תנו שם לתבנית.', 'info'); return; }
      const o = st.opts, e = ep();
      const data = { ...Object.fromEntries(KEEP.map((k) => [k, o[k]])), image: o.image, show: { ...o.show }, blocks: o.blocks.map((b) => ({ id: b.id, on: b.on })), moreCount: o.moreCount, siteLabel: o.siteLabel, ...Object.fromEntries(TEXT.map((k) => [k, cut(toTemplate(o[k], e), 2000)])) };
      const t = { name: name.slice(0, 40), at: Date.now(), kind: st.kind, data };
      S.prefs.set(TEMPLATES, [t, ...templates().filter((x) => x.name !== t.name)].slice(0, 12));
      if (input) input.value = '';
      paintTemplates(); U.notify(`התבנית "${t.name}" נשמרה בחשבון.`, 'success');
    }
    function applyTemplate(name) {
      const t = templates().find((x) => x.name === name); if (!t) return;
      if (t.kind !== st.kind && M.own(M.KINDS, t.kind) && (t.kind === 'note' || eps().length)) { flush(); st.kind = t.kind; if (t.kind === 'digest' && !st.digest.length) st.digest = digestDefault(); if (t.kind === 'episode' && !ep()) st.id = (eps().find(isLive) || eps()[0])?.id || ''; st.opts = optionsFor(st.kind, ep()); }
      const d = obj(t.data), e = ep(), o = { ...st.opts };
      [...KEEP, 'image'].forEach((k) => { if (typeof d[k] === 'string') o[k] = d[k]; });
      o.show = { ...o.show, ...obj(d.show) };
      if (Array.isArray(d.blocks)) o.blocks = M.blocksFor({ blocks: d.blocks });
      o.moreCount = clamp(d.moreCount, 1, 4, o.moreCount);
      TEXT.forEach((k) => { if (typeof d[k] === 'string') o[k] = fill(d[k], e); });
      if (typeof d.siteLabel === 'string' && d.siteLabel) o.siteLabel = d.siteLabel;
      if (!M.own(M.STYLES, o.style)) o.style = 'night';
      if (!M.own(M.FONT_SETS, o.font)) o.font = 'modern';
      if (!M.own(M.SHAPES, o.shape)) o.shape = 'pill';
      st.opts = o; st.dirty = true; save(); render();
      U.notify(`הוחלה התבנית "${t.name}".`, 'success');
    }

    /* ---------- אירועים ---------- */

    root.addEventListener('input', (ev) => {
      const t = ev.target, k = t.dataset.m; if (!k || !st.opts) return;
      if (k === 'ep' || k === 'moreCount') return;
      if (k === 'list') { rememberLines(t.value); st.rcp = { ...st.rcp, state: 'ready', list: M.parseEmails(t.value), source: 'manual' }; st.error = ''; paintRecipients(false); paintResult(); paintChecks(); return; }
      if (k === 'exclude') { st.exclude = M.parseEmails(t.value); paintRecipients(false); paintChecks(); save(); return; }
      if (k === 'to') { st.to = t.value.trim(); return; }
      if (k === 'replyTo') { st.replyTo = t.value.trim(); save(); return; }
      if (k === 'chunk') { st.chunk = clamp(t.value, 1, 2000, 1); paintRecipients(false); save(); return; }
      if (k === 'accent') { st.opts.accent = t.value; const r = $('[data-mop="accent-reset"]'); if (r) r.hidden = false; paintContrast(); }
      else if (OPT.has(k)) { st.opts[k] = t.value; if (WORKED.includes(k)) st.dirty = true; }
      else return;
      if (k === 'description') paintDescNote();
      if (k === 'image') {
        const ok = /^https:\/\/\S+$/i.test(t.value.trim());
        // קישור לתמונה כש"בלי תמונה" מסומן — מציגים אותה (בהודעה ובסיכום: באנר גדול למעלה)
        if (ok && st.opts.cover === 'none') st.opts.cover = st.kind === 'episode' ? 'head' : 'full';
        $$('[data-mcover]').forEach((x) => { x.disabled = x.dataset.mcover !== 'none' && !(ep()?.cover || ep()?.thumb) && !ok; x.setAttribute('aria-pressed', String(x.dataset.mcover === st.opts.cover)); });
      }
      save(); preview();
    });
    root.addEventListener('change', async (ev) => {
      const t = ev.target;
      if (t.dataset.m === 'ep') { st.error = ''; pick(t.value); return; }
      if (t.dataset.m === 'moreCount') { st.opts.moreCount = clamp(t.value, 1, 4, 3); save(); preview(); return; }
      if (t.dataset.mshow) { st.opts.show[t.dataset.mshow] = t.checked; save(); preview(); return; }
      if (t.dataset.mblock) {
        const b = st.opts.blocks.find((x) => x.id === t.dataset.mblock); if (b) b.on = t.checked;
        t.closest('.mc-block')?.classList.toggle('off', !t.checked);
        save(); preview(); return;
      }
      if (t.dataset.mpick) {
        const id = t.dataset.mpick;
        st.digest = t.checked ? [...new Set([...st.digest, id])] : st.digest.filter((x) => x !== id);
        st.dirty = true; save(); paintDigestCount(); paintWarn(); preview(); return;
      }
      if (t.matches('[data-m-file]')) {
        const f = t.files?.[0]; t.value = ''; if (!f) return;
        let content = '';
        try { content = await (window.RoshSheet ? window.RoshSheet.text(f) : f.text()); }
        catch (err) { U.notify(err.message, 'error'); return; }
        rememberLines(content);
        const found = M.parseEmails(content);
        // שורות עם "@" שלא יצאה מהן כתובת (david@gmail,com, moshe @gmail.com) — אומרים כמה, כדי שאפשר יהיה לתקן בקובץ
        const bad = content.split(/\r?\n/).filter((l) => l.includes('@') && !M.parseEmails(l).length);
        const badText = bad.length ? ` ${bad.length === 1 ? 'שורה אחת' : `${fmtN(bad.length)} שורות`} בלי כתובת תקינה לא נכנסו (למשל: ${M.unmark(bad[0]).trim().slice(0, 60)}).` : '';
        if (!found.length) { U.notify(`לא נמצאו כתובות מייל בקובץ.${badText}`, 'error', bad.length ? { ttl: 12000 } : undefined); return; }
        const before = st.rcp.list.length;
        setList([...st.rcp.list, ...found]);
        const added = st.rcp.list.length - before;
        U.notify(`${added ? `נוספו ${fmtN(added)} כתובות מהקובץ.` : 'כל הכתובות שבקובץ כבר ברשימה.'}${badText}`, bad.length ? 'info' : 'success', bad.length ? { ttl: 12000 } : undefined);
      }
    });
    root.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); create(); return; }
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && /^[biBI]$/.test(ev.key) && t.matches('textarea[data-m]') && t.previousElementSibling?.matches('.mc-tools')) { ev.preventDefault(); format(t.dataset.m, ev.key.toLowerCase() === 'b' ? 'bold' : 'italic'); return; }
      if (ev.key === 'Escape' && $('details.mc-menu[open]')) { ev.stopPropagation(); ev.preventDefault(); const d = t.closest('details.mc-menu'); closeMenus(); d?.querySelector('summary')?.focus(); return; }
      if (t.matches('[data-mtab]') && /^Arrow(Left|Right)$|^Home$|^End$/.test(ev.key)) {
        ev.preventDefault();
        const i = TABS.findIndex(([k]) => k === t.dataset.mtab), n = TABS.length;
        const j = ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : (i + (ev.key === 'ArrowLeft' ? 1 : -1) + n) % n;   // מימין לשמאל: שמאלה = הבאה
        showTab(TABS[j][0]); $(`[data-mtab="${TABS[j][0]}"]`)?.focus();
      }
    });
    root.addEventListener('click', async (ev) => {
      const sum = ev.target.closest('summary');
      if (sum && root.contains(sum)) {
        const d = sum.parentElement;
        if (d.matches('.mc-menu')) { closeMenus(d); if (d.matches('.mc-sugg') && !d.open) paintSuggestions(); }
        return;
      }
      if (!ev.target.closest('details.mc-menu')) closeMenus();
      const b = ev.target.closest('button'); if (!b || !root.contains(b)) return;
      if (b.dataset.mkind) { setKind(b.dataset.mkind); return; }
      if (b.dataset.mstep) { showTab(b.dataset.mstep); return; }
      if (b.dataset.mtab) { showTab(b.dataset.mtab); return; }
      if (b.dataset.mgo) { showTab(b.dataset.mgo); $(`[data-panel="${b.dataset.mgo}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
      if (b.dataset.mstyle) { st.opts.style = b.dataset.mstyle; st.opts.accent = ''; renderPanel('design'); save(); preview(); $(`[data-mstyle="${b.dataset.mstyle}"]`)?.focus(); return; }
      if (b.dataset.mfont) { st.opts.font = b.dataset.mfont; $$('[data-mfont]').forEach((x) => x.setAttribute('aria-checked', String(x === b))); save(); preview(); return; }
      if (b.dataset.mshape) { st.opts.shape = b.dataset.mshape; $$('[data-mshape]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); save(); preview(); return; }
      if (b.dataset.mcover) { st.opts.cover = b.dataset.mcover; $$('[data-mcover]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); save(); preview(); return; }
      if (b.dataset.mview) {
        st.view = b.dataset.mview;
        $$('[data-mview]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('[data-m-framewrap]')?.classList.toggle('phone', st.view === 'phone'); $('[data-m-inbox]')?.classList.toggle('phone', st.view === 'phone');
        const f = $('[data-m-frame]'), pre = $('[data-m-text]'); if (f) f.hidden = st.view === 'text'; if (pre) pre.hidden = st.view !== 'text';
        preview(true); return;
      }
      if (b.dataset.mmode) { st.mode = b.dataset.mmode; st.error = ''; $$('[data-mmode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paintRecipients(false); paintResult(); paintChecks(); return; }
      if (b.dataset.mmove) { move(b.dataset.id, b.dataset.mmove); return; }
      if (b.dataset.mexpand) {
        const id = b.dataset.mexpand, body = $(`[data-mbody="${id}"]`), open = body?.hidden;
        if (!body) return;
        body.hidden = !open; b.setAttribute('aria-expanded', String(open));
        if (open) { st.expanded.add(id); body.querySelector('textarea, input')?.focus(); } else st.expanded.delete(id);
        return;
      }
      if (b.dataset.mfmt) { format(b.dataset.target, b.dataset.mfmt); return; }
      if (b.dataset.mtoken || b.dataset.memoji) { closeMenus(); insertAt(b.dataset.target, b.dataset.mtoken || b.dataset.memoji); return; }
      if (b.dataset.msubject) { closeMenus(); const el = $('[data-m="subject"]'); if (el) { el.value = b.dataset.msubject; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); } return; }
      if (b.dataset.mfix) { fixAddresses([b.dataset.mfix]); return; }
      if (b.dataset.mtpl) {
        const name = b.dataset.name;
        if (b.dataset.mtpl === 'apply') applyTemplate(name);
        else if (confirm(`למחוק את התבנית "${name}"?`)) { S.prefs.set(TEMPLATES, templates().filter((x) => x.name !== name)); paintTemplates(); }
        return;
      }
      if (b.dataset.mhist) { historyOp(b.dataset.mhist, b.dataset.id); return; }
      switch (b.dataset.mop) {
        case 'create': create(); break;
        case 'create-anyway': create({ force: true, replace: st.errorReplace }); break;
        case 'replace': create({ replace: true }); break;
        case 'test': sendTest(); break;
        case 'auth-help': authIntro(() => {
          if (hasToken()) { U.notify('Gmail כבר מחובר.', 'success'); return; }
          getToken().then(() => U.notify('Gmail מחובר — אפשר ליצור טיוטות.', 'success')).catch((err) => U.notify(err.message, 'error'));
        }); break;
        case 'copy': copyMail(); break;
        case 'copy-html': { closeMenus(); const x = built(); if (x) (await U.copy(x.html)) ? U.notify('קוד ה־HTML הועתק — אפשר להדביק אותו בכל תוכנת דיוור.', 'success') : U.notify('ההעתקה לא הצליחה.', 'error'); break; }
        case 'copy-text': { closeMenus(); const x = built(); if (x) (await U.copy(x.text)) ? U.notify('גרסת הטקסט הועתקה.', 'success') : U.notify('ההעתקה לא הצליחה.', 'error'); break; }
        case 'eml': closeMenus(); downloadEml(); break;
        case 'html-file': { closeMenus(); const x = built(); if (x) { download(fileName('html'), 'text/html', x.html); U.notify('קובץ ה־HTML ירד.', 'success'); } break; }
        case 'accent-reset': st.opts.accent = ''; renderPanel('design'); save(); preview(); break;
        case 'desc-reset': { const e = ep(); if (!e) break; st.opts.description = String(e.description || ''); st.dirty = true; const el = $('[data-m="description"]'); if (el) el.value = st.opts.description; paintDescNote(); save(); preview(); break; }
        case 'work-reset': {
          // המייל הזה חוזר לנוסח של ברירת המחדל — גם הנושא והפתיחה ששמורים כתבנית, שאחרת היו חוזרים
          const rest = { ...work() }; delete rest[keyFor()]; S.prefs.set(WORK, rest);
          if (st.kind === 'digest') st.digest = liveEps().slice(0, 3).map((e) => e.id);
          const e = ep(), d = M.defaults(e, ctxFor(st.kind, e), st.kind);
          st.opts = optionsFor(st.kind, e);
          [...TEXT, 'description', 'quote', 'quoteBy', 'siteLabel', 'image'].forEach((k) => { st.opts[k] = d[k] ?? ''; });
          st.restored = 0; st.dirty = false; st.pending = true; flush();
          renderPanel('content'); renderPanel('design'); preview(true);
          U.notify('המייל חזר לנוסח של ברירת המחדל.', 'info'); break;
        }
        case 'reset': closeMenus(); if (confirm('לחזור לעיצוב ולניסוח של ברירת המחדל? (התבניות, ההיסטוריה ורשימת "לא לשלוח אל" נשארות.)')) { clearTimeout(saveTimer); st.pending = false; st.dirty = false; S.prefs.set(PREF, { chunk: st.chunk, replyTo: st.replyTo, exclude: st.exclude }); const rest = { ...work() }; delete rest[keyFor()]; S.prefs.set(WORK, rest); st.opts = optionsFor(st.kind, ep()); render(); } break;
        case 'digest-latest': st.digest = liveEps().slice(0, 3).map((e) => e.id); st.dirty = true; save(); renderPanel('content'); preview(); break;
        case 'digest-month': { const from = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10); st.digest = liveEps().filter((e) => (e.date || '') >= from).map((e) => e.id); if (!st.digest.length) U.notify('לא עלו תוכניות בחודש האחרון.', 'info'); st.dirty = true; save(); renderPanel('content'); preview(); break; }
        case 'digest-none': st.digest = []; st.dirty = true; save(); renderPanel('content'); preview(); break;
        case 'tpl-save': saveTemplate(); break;
        case 'fix-all': fixAddresses(st.quality.typos.map((t) => t.email)); break;
        case 'drop-risky': { const add = st.quality.risky; st.exclude = [...new Set([...st.exclude, ...add])]; const ta = $('[data-m="exclude"]'); if (ta) ta.value = st.exclude.join('\n'); save(); paintRecipients(false); paintChecks(); U.notify(`${fmtN(add.length)} כתובות הוצאו מהטיוטות.`, 'success'); break; }
        case 'hist-check': checkHistory(true); break;
        case 'hist-clear': if (confirm('לנקות את רשימת הטיוטות שנוצרו? הטיוטות עצמן נשארות בג\'ימייל.')) { syncHistory(); st.history.forEach((h) => forgotten.add(hid(h))); st.history = []; saveHistory(); paintHistory(); paintResult(); paintWarn(); } break;
        case 'import': $('[data-m-file]')?.click(); break;
        case 'add-open': { const box = $('[data-m-listbox]'), el = $('[data-m="list"]'); if (!box || !el) break; box.open = true; if (el.value && !el.value.endsWith('\n')) el.value += '\n'; el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.scrollTop = el.scrollHeight; box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); break; }
        case 'save-list': saveToList(b); break;
        case 'reload-list': loadRecipients(); break;
        case 'copy-list': (await U.copy(effective().join(', '))) ? U.notify(`${fmtN(effective().length)} כתובות הועתקו.`, 'success') : U.notify('ההעתקה לא הצליחה.', 'error'); break;
      }
    });
    function paintSuggestions() {
      const box = $('[data-m-suggest]'); if (!box) return;
      const list = M.suggestSubjects(ep(), ctxFor(), st.kind, digestEps().map(itemFor));
      box.innerHTML = list.map((s) => `<button type="button" data-msubject="${esc(s)}">${esc(s)}</button>`).join('');
    }

    // לפני שהדף נסגר או עובר לרקע: מה שעוד מחכה לשמירה נכנס לחשבון. בשלב הלכידה, כדי לרוץ לפני
    // המאזין של store.js — והוא שולח את הכל בבקשה אחת
    const leave = () => { if (root.isConnected) flush(); };
    window.addEventListener('pagehide', leave, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); }, true);
    // לחיצה מחוץ לעורך סוגרת תפריט פתוח
    document.addEventListener('click', (ev) => { if (root.isConnected && !root.contains(ev.target)) closeMenus(); });

    /* ---------- התחלה ---------- */
    const all = eps();
    if (!all.length) st.kind = 'note';
    if (st.kind === 'episode') st.id = (all.find((e) => e.id === cfg.episodeId) || all.find(isLive) || all[0]).id;
    if (st.kind === 'digest') st.digest = digestDefault();
    st.opts = optionsFor(st.kind, ep());
    render();
    prepare();
    loadRecipients();
    return { pick, setKind, flush, get episodeId() { return st.id; }, get kind() { return st.kind; } };
  }

  /** בחלון מעל אזור הניהול */
  function open(cfg) {
    let d = document.getElementById('dlg-mail');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'dlg-mail'; d.className = 'sheet mail-sheet'; d.setAttribute('aria-labelledby', 'dlg-mail-title');
      document.body.appendChild(d);
      d.addEventListener('click', (ev) => { if (ev.target.closest('[data-close]')) d.close(); });
    }
    d.innerHTML = `<div class="section-title"><div><p class="kicker">רשימת התפוצה</p><h2 id="dlg-mail-title">טיוטת מייל</h2></div><button type="button" class="icon-btn" data-close aria-label="סגירה">✕</button></div><div class="card-body" data-mail-host></div>`;
    const ctl = mount(d.querySelector('[data-mail-host]'), cfg);
    d.onclose = () => ctl.flush();   // מה שנערך נשמר בחשבון גם כשסוגרים מיד
    if (!d.open) d.showModal();
    return ctl;
  }

  window.RoshMailComposer = { mount, open, prepare };
})();
