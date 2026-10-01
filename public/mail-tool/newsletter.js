/* המייל למאזינים: בונה את הטיוטה שנוצרת בג'ימייל.
   מודול טהור — בלי DOM ובלי רשת — כדי שאפשר יהיה לבדוק אותו ב־Node:
     build(episode, ctx, opts) → { subject, preheader, html, bodyHtml, text, palette, size, report }
     audit(mail, info)         → הבדיקות לפני יצירת הטיוטה: שגיאות, אזהרות ומה שתקין
     mime(msg) / raw(msg)      → ההודעה כ־MIME (לקובץ ‎.eml) / בקידוד base64url (מה ש־Gmail מקבל)
     suggestSubjects, checkAddresses, dailyLimit, parseEmails, chunk, rich, plain, tokens
   שלושה סוגים: תוכנית חדשה, סיכום של כמה תוכניות, והודעה חופשית. גוף המייל בנוי מבלוקים
   (פתיחה, כפתורים, תיאור, שירים, ציטוט, קישורים, כפתור נוסף, עוד תוכניות, שיתוף, חתימה)
   בסדר שבוחרים בעורך. בטקסט אפשר **הדגשה**, *נטוי*, [קישור](https://…) ורשימות (שורות
   שמתחילות ב־"- " או "1. "), ומשתנים כמו {{title}} מתמלאים לפי התוכנית.
   המייל בנוי מטבלאות עם עיצוב בתוך התגיות (inline), מימין לשמאל, וצבעים הקסדצימליים
   בלבד — כמו שתוכנות הדואר (ג'ימייל, אאוטלוק, הטלפון) מציגות נכון. */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[k]);
  const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);   // "constructor" אינו סגנון
  const clamp = (n, lo, hi, fb) => { const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb; };

  /* ---------- גופנים, צורות וסגנונות ---------- */

  const FONT_SETS = {
    modern: { name: 'מודרני', hint: 'Heebo וכותרת צרה — כמו האתר', sans: "Heebo, 'Segoe UI', 'Arial Hebrew', Arial, sans-serif", display: "Karantina, Heebo, 'Arial Hebrew', Arial, sans-serif", css: 'family=Heebo:wght@400;700;900&family=Karantina:wght@700', size: 46, weight: 700, lh: 1.05 },
    classic: { name: 'קלאסי', hint: 'Frank Ruhl — כמו עיתון', sans: "'Frank Ruhl Libre', David, 'Times New Roman', serif", display: "'Frank Ruhl Libre', David, 'Times New Roman', serif", css: 'family=Frank+Ruhl+Libre:wght@400;700;900', size: 36, weight: 900, lh: 1.2 },
    soft: { name: 'רך', hint: 'Rubik — עגול וידידותי', sans: "Rubik, Heebo, 'Arial Hebrew', Arial, sans-serif", display: "Rubik, Heebo, 'Arial Hebrew', Arial, sans-serif", css: 'family=Rubik:wght@400;700;900', size: 36, weight: 900, lh: 1.2 },
  };
  const fontsUrl = (key) => `https://fonts.googleapis.com/css2?${(own(FONT_SETS, key) ? FONT_SETS[key] : FONT_SETS.modern).css}&display=swap`;
  const FONTS_URL = fontsUrl('modern');
  const SHAPES = { pill: { name: 'עגול', r: 999 }, round: { name: 'מעוגל', r: 12 }, square: { name: 'ישר', r: 4 } };

  function rgbOf(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  /** "#f0c65a" → הצבע של הטקסט שיושב עליו (כהה על צבע בהיר, לבן על צבע כהה) */
  function inkFor(hex) {
    const c = rgbOf(hex);
    if (!c) return '#15110a';
    return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 150 ? '#15110a' : '#ffffff';
  }
  function luminance(hex) {
    const c = rgbOf(hex); if (!c) return 0;
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  /** יחס הניגודיות בין שני צבעים (1–21), כמו בתקן הנגישות */
  function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  /** צבע HSL כהקסדצימלי — אאוטלוק לא מבין hsl() */
  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }

  const STYLES = {
    night: { name: 'אולפן לילה', hint: 'כמו האתר: רקע חצות וזהב חם', bg: '#06080f', card: '#121729', text: '#f6f2e8', muted: '#b3ad9e', accent: '#f0c65a', border: '#2a3048', soft: '#1a2036', dark: true },
    gold: { name: 'זהב בהיר', hint: 'קרם חם, זהב עמוק — נעים לקריאה', bg: '#f5f0e6', card: '#fffcf6', text: '#140f08', muted: '#6b6252', accent: '#a87a12', border: '#e8dfc8', soft: '#f7f1e3', dark: false },
    clean: { name: 'נקי', hint: 'לבן, שחור, מינימלי', bg: '#f2f2f2', card: '#ffffff', text: '#111111', muted: '#6a6a6a', accent: '#111111', border: '#e4e4e4', soft: '#f6f6f6', dark: false },
    vivid: { name: 'צבעוני', hint: 'הצבע של התוכנית, כמו העטיפה שלה באתר', bg: null, card: null, text: '#ffffff', muted: '#d7d2e6', accent: null, border: null, soft: null, dark: true },
    ocean: { name: 'כחול עמוק', hint: 'כחול לילה וטורקיז', bg: '#071a2b', card: '#0d2640', text: '#eef6fb', muted: '#9fb7c9', accent: '#3fd0c9', border: '#1d3b58', soft: '#12304f', dark: true },
    paper: { name: 'מכתב', hint: 'נייר חם ודיו אדום־חום', bg: '#ece7dc', card: '#fbf8f1', text: '#1f1a14', muted: '#6f675b', accent: '#8c2f1b', border: '#ddd4c3', soft: '#f3eee3', dark: false },
  };
  /** הסגנון המלא לתוכנית: הצבעוני נגזר מהגוון, ואפשר להחליף את צבע ההדגשה */
  function palette(opts = {}, ctx = {}) {
    const key = own(STYLES, opts.style) ? opts.style : 'night';
    const p = { ...STYLES[key], key };
    if (key === 'vivid') {
      const h = Number.isFinite(Number(ctx.hue)) ? Number(ctx.hue) : 268;
      Object.assign(p, { bg: hslHex(h, 55, 10), card: hslHex(h, 40, 17), border: hslHex(h, 35, 26), soft: hslHex(h, 38, 21), accent: hslHex((h + 40) % 360, 90, 70) });
    }
    if (/^#[0-9a-f]{6}$/i.test(opts.accent || '')) p.accent = opts.accent;
    p.accentInk = inkFor(p.accent);
    // קישורים בתוך הטקסט: בצבע ההדגשה — אלא אם הוא לא קריא על הרקע של הכרטיס
    p.link = contrast(p.accent, p.card) >= 3 ? p.accent : p.text;
    return p;
  }

  /* ---------- סוגי המייל והבלוקים ---------- */

  const KINDS = {
    episode: { name: 'תוכנית חדשה', hint: 'מייל על תוכנית אחת: האזנה, הורדה ותיאור', fallback: '' },
    digest: { name: 'סיכום תוכניות', hint: 'כמה תוכניות במייל אחד — "מה פספסתם"', fallback: 'התוכניות האחרונות' },
    note: { name: 'הודעה חופשית', hint: 'עדכון, ברכה או הזמנה — בלי תוכנית במרכז', fallback: 'עדכון' },
  };
  const ALL = ['episode', 'digest', 'note'];
  const BLOCKS = {
    intro: { name: 'פתיחה', hint: 'כמה מילים בראש המייל', kinds: ALL },
    items: { name: 'התוכניות בסיכום', hint: 'כרטיס לכל תוכנית: האזנה והורדה', kinds: ['digest'] },
    buttons: { name: 'הכפתורים', hint: 'האזנה באתר והורדה ישירה', kinds: ALL },
    description: { name: 'תיאור התוכנית', hint: 'מתוך האתר, ואפשר לערוך למייל בלבד', kinds: ['episode'] },
    tracks: { name: 'השירים בתוכנית', hint: 'עם קישור לכל שיר ברגע שלו', kinds: ['episode'] },
    quote: { name: 'ציטוט מודגש', hint: 'משפט אחד שבולט — מהראיון או מהאורח', kinds: ALL },
    links: { name: 'קישורים מדף התוכנית', hint: 'הקישורים הציבוריים של התוכנית', kinds: ['episode'] },
    cta: { name: 'כפתור נוסף', hint: 'הצבעה, סקר, הרשמה — כל קישור', kinds: ALL },
    more: { name: 'עוד תוכניות', hint: 'התוכניות האחרונות שאולי פספסו', kinds: ['episode', 'note'] },
    share: { name: 'שיתוף עם חברים', hint: 'שליחה לחבר במייל', kinds: ALL },
    signature: { name: 'חתימה', hint: 'בסוף המייל', kinds: ALL },
  };
  const DEFAULT_BLOCKS = [['intro', 1], ['items', 1], ['buttons', 1], ['description', 1], ['tracks', 1], ['quote', 1], ['links', 1], ['cta', 1], ['more', 0], ['share', 0], ['signature', 1]].map(([id, on]) => ({ id, on: !!on }));
  /** סדר הבלוקים ומה פעיל: מהעורך, או ברירת המחדל. בלוק חדש שלא היה בשמירה ישנה נכנס במקומו הרגיל. */
  function blocksFor(o = {}) {
    const src = Array.isArray(o.blocks) && o.blocks.length ? o.blocks : null;
    const out = [], seen = new Set();
    for (const b of src || DEFAULT_BLOCKS) {
      if (!b || !own(BLOCKS, b.id) || seen.has(b.id)) continue;
      seen.add(b.id); out.push({ id: b.id, on: b.on !== false });
    }
    DEFAULT_BLOCKS.forEach((b, i) => { if (!seen.has(b.id)) out.splice(Math.min(i, out.length), 0, { ...b }); });
    if (!src) out.forEach((b) => { if ((b.id === 'description' || b.id === 'links') && o.show?.[b.id] === false) b.on = false; });   // הגדרות מלפני הבלוקים
    return out;
  }

  /* ---------- טקסטים: פסקאות, עיצוב קל ומשתנים ---------- */

  const label = (e) => String(e?.title || '').trim() || 'תוכנית בלי שם';
  const paragraphs = (text) => String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const firstSentence = (text, max = 120) => (paragraphs(text)[0] || '').split(/(?<=[.!?…])\s/)[0].replace(/\s+/g, ' ').trim().slice(0, max);

  // [טקסט](קישור) · **הדגשה** · *נטוי* · קישור חשוף
  const INLINE = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)|\*\*(?![\s*])([^*\n]*?[^\s*])\*\*|\*(?![\s*])([^*\n]*?[^\s*])\*|(https?:\/\/[^\s<>"'()[\]]*[^\s<>"'()[\].,!?:;…])/g;
  const LIST_ITEM = /^\s*(?:([-•*])|(\d{1,3})[.)])\s+(\S.*)$/;
  function inlineHtml(s, p) {
    s = String(s);
    const a = (href, inner) => `<a href="${esc(href)}" target="_blank" style="color:${p.link};font-weight:800;text-decoration:underline;text-underline-offset:3px">${inner}</a>`;
    let out = '', last = 0;
    for (const m of s.matchAll(INLINE)) {
      out += esc(s.slice(last, m.index)); last = m.index + m[0].length;
      if (m[1] != null) out += a(m[2], esc(m[1]));
      else if (m[3] != null) out += `<strong style="font-weight:900">${esc(m[3])}</strong>`;
      else if (m[4] != null) out += `<em style="font-style:italic">${esc(m[4])}</em>`;
      else out += a(m[5], `<span dir="ltr" style="unicode-bidi:isolate">${esc(m[5])}</span>`);
    }
    return out + esc(s.slice(last));
  }
  const inlinePlain = (s) => String(s).replace(INLINE, (m, lt, lu, b, i, u) => (lt != null ? (lt.trim() === lu ? lu : `${lt} (${lu.replace(/^(mailto|tel):/i, '')})`) : b ?? i ?? u));
  /** הטקסט כפסקאות ורשימות: [{ type: 'p'|'ul'|'ol', lines, start }] */
  function textBlocks(text) {
    const out = [];
    for (const para of paragraphs(text)) {
      let cur = null;
      for (const line of para.split('\n')) {
        const m = LIST_ITEM.exec(line), type = m ? (m[2] ? 'ol' : 'ul') : 'p';
        if (!cur || cur.type !== type) { cur = { type, lines: [], start: m?.[2] ? Number(m[2]) : 1 }; out.push(cur); }
        cur.lines.push(m ? m[3].trim() : line.trim());
      }
    }
    return out;
  }
  /** טקסט עם עיצוב קל → HTML למייל */
  function rich(text, p, { size = 16, color, font = FONT_SETS.modern.sans, mb = 12 } = {}) {
    const base = `font-family:${font};font-size:${size}px;line-height:1.75;color:${color || p.text}`;
    return textBlocks(text).map((b) => {
      if (b.type === 'p') return `<p style="margin:0 0 ${mb}px;${base}">${b.lines.map((l) => inlineHtml(l, p)).join('<br>')}</p>`;
      return `<${b.type} dir="rtl"${b.type === 'ol' && b.start !== 1 ? ` start="${b.start}"` : ''} style="margin:0 0 ${mb}px;padding:0 22px 0 0;${base}">${b.lines.map((l) => `<li style="margin:0 0 4px">${inlineHtml(l, p)}</li>`).join('')}</${b.type}>`;
    }).join('');
  }
  /** אותו טקסט לגרסה הפשוטה (בלי HTML): קישור → "טקסט (כתובת)", רשימה → "• " */
  function plain(text) {
    return textBlocks(text).map((b) => (b.type === 'p' ? b.lines.map(inlinePlain).join('\n') : b.lines.map((l, i) => `${b.type === 'ol' ? `${b.start + i}.` : '•'} ${inlinePlain(l)}`).join('\n'))).join('\n\n');
  }

  const TOKENS = [['title', 'שם התוכנית'], ['number', 'מספר התוכנית'], ['date', 'התאריך'], ['guests', 'האורחים'], ['duration', 'האורך'], ['site', 'שם האתר'], ['count', 'כמה תוכניות (בסיכום)']];
  const TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}/g;
  /** {{title}} וחבריו → הערכים של התוכנית. משתנה לא מוכר נשאר כמו שהוא (והבדיקה מתריעה עליו). */
  function tokens(text, vars = {}, report = null) {
    return String(text ?? '').replace(TOKEN, (m, k) => {
      const key = k.toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(vars, key)) { report?.leftover.add(m); return m; }
      const v = vars[key];
      if (v == null || v === '') { report?.empty.add(`{{${key}}}`); return ''; }
      return String(v);
    });
  }
  const clock = (sec) => { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`; };

  /** ברירות המחדל לפי סוג המייל. השאר (סגנון, חתימה, בלוקים) נשמר בין מייל למייל. */
  function defaults(episode, ctx = {}, kind = 'episode') {
    if (!own(KINDS, kind)) kind = 'episode';
    const name = ctx.siteName || 'ראש בראש';
    const base = {
      kind: own(KINDS, kind) ? kind : 'episode',
      style: 'night', accent: '', cover: 'head', font: 'modern', shape: 'pill', image: '',
      listenLabel: 'להאזנה באתר', downloadLabel: 'הורדת התוכנית', siteLabel: kind === 'digest' ? 'לכל התוכניות באתר' : 'לאתר התוכנית',
      // התיאור במייל: מתחיל מהתיאור של התוכנית באתר, ואפשר לערוך אותו למייל בלבד
      description: String(episode?.description || ''), descTitle: 'על התוכנית',
      tracksTitle: 'השירים בתוכנית', quote: '', quoteBy: '', ctaLabel: '', ctaUrl: '',
      moreTitle: 'עוד תוכניות שכדאי לשמוע', moreCount: 3,
      shareTitle: 'מכירים מישהו שייהנה?', shareText: 'העבירו לו את המייל או שלחו לו קישור לתוכנית.',
      preheader: '', signature: `שבוע טוב ומוזיקלי,\nצוות ${name}`,
      show: { description: true, guests: true, links: true, download: true, phone: true, unsubscribe: true, tagline: true },
      // blocks: הסדר ומה פעיל — כשאין, blocksFor() נותן את ברירת המחדל
    };
    if (kind === 'digest') return { ...base, headline: 'התוכניות האחרונות שלנו', subject: `🎧 {{count}} תוכניות ב${name} שכדאי לשמוע`, intro: 'שלום!\nריכזנו בשבילכם את התוכניות האחרונות — כל אחת בלחיצה: להאזנה באתר או להורדה.' };
    if (kind === 'note') return { ...base, headline: `עדכון מ${name}`, subject: `📣 עדכון מ${name}`, intro: 'שלום לכולם!' };
    return { ...base, headline: '', subject: `🎙️ תוכנית חדשה ב${name}: ${label(episode)}`, intro: `שלום!\nתוכנית חדשה עלתה לאתר — "${label(episode)}". מוזמנים להאזין באתר, או להוריד את הקובץ ולשמוע בדרך.` };
  }

  /* ---------- ה־HTML ---------- */

  /**
   * episode: התוכנית (בסיכום ובהודעה — לא חובה)
   * ctx: { siteName, tagline, siteUrl, homeUrl, archiveUrl, listenUrl, downloadUrl, shareUrl, unsubscribeUrl, dateText, durationText, hue, links,
   *        contacts:{ phone, phoneNote }, items:[פריט], more:[פריט] }
   *   פריט (תוכנית בסיכום או ב"עוד תוכניות"): { title, number, url, downloadUrl, dateText, durationText, thumb, hue, excerpt }
   * opts: כמו defaults() אחרי עריכה.
   */
  function build(episode, ctx = {}, opts = {}) {
    const kind = own(KINDS, opts.kind) ? opts.kind : 'episode';
    const d = defaults(episode, ctx, kind);
    const o = { ...d, ...opts, kind, show: { ...d.show, ...(opts.show || {}) } };
    const e = episode || {};
    const p = palette(o, ctx);
    const F = own(FONT_SETS, o.font) ? FONT_SETS[o.font] : FONT_SETS.modern;
    const radius = (own(SHAPES, o.shape) ? SHAPES[o.shape] : SHAPES.pill).r;
    const name = ctx.siteName || 'ראש בראש';
    const items = kind === 'digest' && Array.isArray(ctx.items) ? ctx.items.filter(Boolean) : [];
    const guests = kind === 'episode' && Array.isArray(e.guests) ? e.guests.filter(Boolean) : [];
    const report = { leftover: new Set(), empty: new Set() };
    const vars = { title: '', number: kind === 'episode' ? e.number ?? '' : '', date: ctx.dateText || '', guests: guests.join(', '), duration: kind === 'episode' ? ctx.durationText || '' : '', site: name, count: items.length || '' };
    const headline = kind === 'episode' ? label(e) : (tokens(o.headline, vars, report).trim() || KINDS[kind].fallback);
    vars.title = headline;
    const t = (s) => tokens(s, vars, report);
    const subject = t(o.subject).replace(/\s+/g, ' ').trim();

    const kicker = kind === 'episode' ? [name, e.number != null && e.number !== '' ? `תוכנית ${e.number}` : ''].filter(Boolean).join(' · ')
      : kind === 'digest' ? `${name} · ${items.length === 1 ? 'תוכנית אחת' : `${items.length} תוכניות`}` : name;
    const dates = items.map((i) => i.dateText).filter(Boolean);
    const meta = kind === 'episode' ? [ctx.dateText, ctx.durationText, o.show.guests && guests.length ? `עם ${guests.join(', ')}` : ''].filter(Boolean)
      : kind === 'digest' ? (dates.length > 1 && dates[0] !== dates.at(-1) ? [`${dates.at(-1)} – ${dates[0]}`] : dates.slice(0, 1)) : [ctx.dateText].filter(Boolean);
    // תמונה: קישור משלכם, או התמונה של התוכנית — בכותרת (מעל השם) או גדולה לכל הרוחב.
    // "side" (ליד הכותרת) מגרסה קודמת — מוצג עכשיו בכותרת.
    const custom = /^https:\/\/\S+$/i.test(String(o.image || '').trim()) ? String(o.image).trim() : '';
    const cover = custom || (kind === 'episode' ? String(e.cover || e.thumb || '') : '');
    const coverMode = cover && o.cover !== 'none' ? (o.cover === 'full' ? 'full' : 'head') : 'none';

    const td = (inner, style = '', attrs = '') => `<td dir="rtl" align="right" style="${style}" ${attrs}>${inner}</td>`;
    const row = (inner, pad = '18px 32px 0') => `<tr>${td(inner, `padding:${pad}`, 'class="p"')}</tr>`;
    const box = (inner, style) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl"><tr>${td(inner, style)}</tr></table>`;
    const R = (text, x = {}) => rich(text, p, { font: F.sans, ...x });
    const secTitle = (s) => (s ? `<p style="margin:0 0 8px;font-family:${F.sans};font-size:13px;font-weight:900;letter-spacing:.02em;color:${p.accent}">${esc(s)}</p>` : '');
    const BTN = {
      primary: `background:${p.accent};color:${p.accentInk};border:2px solid ${p.accent}`,
      ghost: `background:transparent;color:${p.text};border:2px solid ${p.border}`,
      outline: `background:transparent;color:${p.link};border:2px solid ${p.accent}`,
    };
    const button = (b) => `<a href="${esc(b.href)}" target="_blank" style="display:inline-block;padding:14px 26px;border-radius:${radius}px;font-family:${F.sans};font-size:16px;font-weight:900;line-height:1.2;text-align:center;white-space:nowrap;text-decoration:none;mso-padding-alt:0;${BTN[b.look] || BTN.ghost}">${esc(b.text)}</a>`;
    const buttons = (list) => `<table role="presentation" class="bts" cellpadding="0" cellspacing="0" border="0" dir="rtl"><tr>${list.map((b, i) => td(button(b), `padding:6px 0 6px ${i < list.length - 1 ? 10 : 0}px`, 'class="bt"')).join('')}</tr></table>`;

    /* כרטיס תוכנית — בסיכום, וב"עוד תוכניות" (מקוצר) */
    const itemMeta = (it) => [it.number != null && it.number !== '' ? `תוכנית ${it.number}` : '', it.dateText, it.durationText].filter(Boolean).join(' · ');
    const card = (it, compact) => {
      const h = Number.isFinite(Number(it.hue)) ? Number(it.hue) : 268;
      const tile = it.thumb
        ? `<img src="${esc(it.thumb)}" width="84" height="84" alt="" style="display:block;width:84px;height:84px;border-radius:14px;object-fit:cover;border:1px solid ${p.border}">`
        : `<table role="presentation" width="84" cellpadding="0" cellspacing="0" border="0"><tr><td width="84" height="84" align="center" valign="middle" bgcolor="${hslHex(h, 45, 22)}" style="width:84px;height:84px;border-radius:14px;background:${hslHex(h, 45, 22)};font-family:${FONT_SETS.modern.display};font-size:34px;font-weight:700;line-height:84px;color:${hslHex((h + 40) % 360, 90, 72)};text-align:center">${esc(it.number ?? '♪')}</td></tr></table>`;
      const m = itemMeta(it), dl = o.show.download && it.downloadUrl;
      const lk = (href, text) => `<a href="${esc(href)}" target="_blank" style="color:${p.link};font-weight:900;text-decoration:none">${text}</a>`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl"><tr>
${td(tile, 'width:84px;padding:0 0 0 16px;vertical-align:top')}
${td(`${m ? `<p style="margin:0 0 4px;font-family:${F.sans};font-size:12.5px;font-weight:800;color:${p.muted}">${esc(m)}</p>` : ''}<p style="margin:0 0 6px;font-family:${F.sans};font-size:18px;font-weight:900;line-height:1.35"><a href="${esc(it.url || '#')}" target="_blank" style="color:${p.text};text-decoration:none">${esc(it.title || 'תוכנית')}</a></p>${!compact && it.excerpt ? `<p style="margin:0 0 8px;font-family:${F.sans};font-size:14.5px;line-height:1.65;color:${p.text}">${esc(it.excerpt)}</p>` : ''}<p style="margin:0;font-family:${F.sans};font-size:14px">${lk(it.url || '#', '▶ להאזנה')}${dl ? ` <span style="color:${p.muted}">&nbsp;·&nbsp;</span> ${lk(it.downloadUrl, '⬇ הורדה')}` : ''}</p>`, 'vertical-align:top')}
</tr></table>`;
    };
    const cards = (list, compact) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl">${list.map((it, i) => `${i ? '<tr><td style="height:10px;line-height:10px;font-size:0">&nbsp;</td></tr>' : ''}<tr>${td(card(it, compact), `padding:14px 16px;background:${p.soft};border-radius:18px`)}</tr>`).join('')}</table>`;
    const itemText = (it) => { const m = itemMeta(it); return [`▶ ${it.title || 'תוכנית'}${m ? ` (${m})` : ''}`, it.url || '', o.show.download && it.downloadUrl ? `הורדה: ${it.downloadUrl}` : ''].filter(Boolean).join('\n'); };

    /* הבלוקים */
    const introText = t(o.intro), sigText = t(o.signature);
    const descText = kind === 'episode' ? t(typeof o.description === 'string' ? o.description : String(e.description || '')) : '';
    const listenUrl = ctx.listenUrl || ctx.siteUrl || '#';
    const download = kind === 'episode' && o.show.download && ctx.downloadUrl ? ctx.downloadUrl : '';
    const links = kind === 'episode' && Array.isArray(ctx.links) ? ctx.links.filter((l) => l && l.url) : [];
    const tracks = kind === 'episode' && Array.isArray(e.tracks) ? e.tracks.filter((x) => x && (x.title || x.artist)) : [];
    const more = (Array.isArray(ctx.more) ? ctx.more.filter(Boolean) : []).slice(0, clamp(o.moreCount, 1, 4, 3));
    const ctaUrl = String(o.ctaUrl || '').trim(), ctaLabel = t(o.ctaLabel).trim();
    const ctaOk = !!ctaLabel && /^(https?:\/\/|mailto:|tel:)\S+$/i.test(ctaUrl);
    const quote = t(o.quote).trim(), quoteBy = t(o.quoteBy).trim();
    const shareUrl = ctx.shareUrl || ctx.listenUrl || ctx.siteUrl || '';
    const mainButtons = kind === 'episode'
      ? [{ href: listenUrl, text: `▶  ${o.listenLabel || 'להאזנה באתר'}`, look: 'primary', label: o.listenLabel || 'להאזנה באתר' }, ...(download ? [{ href: download, text: `⬇  ${o.downloadLabel || 'הורדת התוכנית'}`, look: 'ghost', label: o.downloadLabel || 'הורדת התוכנית' }] : [])]
      : [{ href: (kind === 'digest' ? ctx.archiveUrl : ctx.homeUrl) || ctx.siteUrl || '#', text: t(o.siteLabel) || 'לאתר התוכנית', look: 'primary', label: t(o.siteLabel) || 'לאתר התוכנית' }];

    const B = {
      intro: () => { const h = R(introText); return h && { html: row(h), text: plain(introText) }; },
      items: () => items.length && { html: row(cards(items, false), '14px 32px 0'), text: items.map(itemText).join('\n\n') },
      buttons: () => ({ html: row(buttons(mainButtons), '14px 32px 10px'), text: mainButtons.map((b) => `${b.label}: ${b.href}`).join('\n') }),
      description: () => {
        const h = R(descText, { size: 15 }); if (!h) return null;
        const dt = t(o.descTitle ?? 'על התוכנית').trim();
        return { html: row(box(`${secTitle(dt)}${h}`, `padding:18px 20px 8px;background:${p.soft};border-radius:18px`), '14px 32px 0'), text: `${dt ? `${dt}:\n` : ''}${plain(descText)}` };
      },
      tracks: () => {
        if (!tracks.length) return null;
        const shown = tracks.slice(0, 40), tt = t(o.tracksTitle || 'השירים בתוכנית').trim(), timed = shown.some((x) => x.at > 0);
        const at = (x) => (ctx.listenUrl && x.at > 0 ? `${ctx.listenUrl}${ctx.listenUrl.includes('?') ? '&' : '?'}t=${Math.floor(x.at)}` : '');
        const rows = shown.map((x) => `<tr>${timed ? td(at(x) ? `<a href="${esc(at(x))}" target="_blank" dir="ltr" style="color:${p.link};font-weight:900;text-decoration:none;unicode-bidi:isolate">${clock(x.at)}</a>` : '', `width:58px;padding:5px 0 5px 12px;vertical-align:top;font-family:${F.sans};font-size:14px`) : ''}${td(`<b style="color:${p.text}">${esc(x.title || x.artist)}</b>${x.title && x.artist ? ` <span style="color:${p.muted}">— ${esc(x.artist)}</span>` : ''}${x.note ? ` <span style="color:${p.muted};font-size:13px">(${esc(x.note)})</span>` : ''}`, `padding:5px 0;vertical-align:top;font-family:${F.sans};font-size:15px;line-height:1.55;color:${p.text}`)}</tr>`).join('');
        const rest = tracks.length - shown.length;
        return {
          html: row(`${secTitle(tt)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl">${rows}</table>${rest > 0 ? `<p style="margin:6px 0 0;font-family:${F.sans};font-size:13px;font-weight:800;color:${p.muted}">ועוד ${rest} — ברשימה המלאה באתר</p>` : ''}`, '18px 32px 0'),
          text: `${tt}:\n${shown.map((x) => `${x.at > 0 ? `${clock(x.at)}  ` : ''}${x.title || x.artist}${x.title && x.artist ? ` — ${x.artist}` : ''}`).join('\n')}`,
        };
      },
      quote: () => quote && {
        html: row(box(`<p style="margin:0;font-family:Georgia,serif;font-size:44px;line-height:.7;color:${p.accent}">&#8221;</p><p style="margin:4px 0 0;font-family:${F.sans};font-size:19px;font-weight:700;line-height:1.6;color:${p.text}">${quote.split('\n').map((l) => inlineHtml(l, p)).join('<br>')}</p>${quoteBy ? `<p style="margin:8px 0 0;font-family:${F.sans};font-size:14px;font-weight:800;color:${p.muted}">— ${esc(quoteBy)}</p>` : ''}`, `padding:16px 20px;border-right:4px solid ${p.accent};background:${p.soft};border-radius:14px 0 0 14px`)),
        text: `"${plain(quote)}"${quoteBy ? ` — ${quoteBy}` : ''}`,
      },
      links: () => links.length && {
        html: row(`${secTitle('עוד מהתוכנית')}${links.map((l) => `<p style="margin:0 0 6px;font-family:${F.sans};font-size:15px;line-height:1.6"><a href="${esc(l.url)}" target="_blank" style="color:${p.text};font-weight:800;text-decoration:underline;text-underline-offset:3px">${esc(l.label || l.url)}</a></p>`).join('')}`),
        text: links.map((l) => `${l.label || ''}: ${l.url}`).join('\n'),
      },
      cta: () => ctaOk && { html: row(buttons([{ href: ctaUrl, text: ctaLabel, look: 'outline' }]), '14px 32px 0'), text: `${ctaLabel}: ${ctaUrl.replace(/^(mailto|tel):/i, '')}` },
      more: () => {
        if (!more.length) return null;
        const mt = t(o.moreTitle || 'עוד תוכניות').trim();
        return { html: row(`${secTitle(mt)}${cards(more, true)}`, '20px 32px 0'), text: `${mt ? `${mt}:\n` : ''}${more.map(itemText).join('\n\n')}` };
      },
      share: () => {
        if (!shareUrl) return null;
        const st = t(o.shareTitle).trim(), sb = t(o.shareText).trim();
        const mail = `mailto:?subject=${encodeURIComponent(`${headline} · ${name}`)}&body=${encodeURIComponent(`${headline}\n${shareUrl}`)}`;
        return {
          html: row(box(`${secTitle(st)}${sb ? R(sb, { size: 15, mb: 8 }) : ''}${buttons([{ href: mail, text: '✉ שליחה לחבר במייל', look: 'ghost' }])}`, `padding:16px 20px 10px;border:1px dashed ${p.border};border-radius:18px`)),
          text: [st, plain(sb), shareUrl].filter(Boolean).join('\n'),
        };
      },
      signature: () => { const h = R(sigText, { size: 15, color: p.muted }); return h && { html: row(h, '22px 32px 0'), text: plain(sigText) }; },
    };
    const active = blocksFor(o).filter((b) => b.on && BLOCKS[b.id].kinds.includes(kind)).map((b) => b.id);
    const parts = active.map((id) => [id, B[id]()]).filter(([, x]) => x);

    const autoPre = firstSentence(plain(introText)) || firstSentence(plain(descText)) || `${kicker} · ${headline}`;
    const customPre = t(o.preheader).replace(/\s+/g, ' ').trim();
    const preheader = customPre || autoPre;
    const phone = o.show.phone && ctx.contacts?.phone ? ctx.contacts.phone : '';
    const unsub = !!(o.show.unsubscribe && ctx.unsubscribeUrl);

    const titleBlock = `
<p style="margin:0 0 10px;font-family:${F.sans};font-size:13px;font-weight:900;letter-spacing:.02em;color:${p.accent}">✦ ${esc(kicker)}</p>
<h1 class="h1" style="margin:0;font-family:${F.display};font-size:${F.size}px;font-weight:${F.weight};line-height:${F.lh};color:${p.text}">${esc(headline)}</h1>
${meta.length ? `<p style="margin:10px 0 0;font-family:${F.sans};font-size:14px;font-weight:700;line-height:1.6;color:${p.muted}">${esc(meta.join(' · '))}</p>` : ''}`;
    // בכותרת: התמונה ברוחב הכרטיס, מעל הכותרת
    const header = coverMode === 'head'
      ? `<img src="${esc(cover)}" width="536" alt="" class="hc" style="display:block;width:100%;max-width:536px;height:auto;margin:0 0 22px;border-radius:20px;border:1px solid ${p.border}">${titleBlock}`
      : titleBlock;
    const fullCover = coverMode === 'full' ? `<tr>${td(`<img src="${esc(cover)}" width="600" alt="" class="w" style="display:block;width:100%;max-width:600px;height:auto;border:0">`, 'padding:0')}</tr>` : '';
    const fontCss = fontsUrl(o.font);

    const bodyHtml = `
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${p.bg};opacity:0">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="${p.bg}" style="background:${p.bg};margin:0;padding:0">
<tr><td align="center" style="padding:28px 12px 36px">
<table role="presentation" class="w" width="600" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="width:600px;max-width:100%">
${o.show.tagline !== false ? `<tr>${td(`<span style="font-family:${F.sans};font-size:13px;font-weight:900;letter-spacing:.03em;color:${p.muted}">${esc(ctx.tagline || name)}</span>`, 'padding:0 6px 14px')}</tr>` : ''}
<tr><td dir="rtl" bgcolor="${p.card}" style="background:${p.card};border:1px solid ${p.border};border-radius:26px;overflow:hidden">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl">
${fullCover}
<tr>${td(header, 'padding:30px 32px 6px', 'class="p"')}</tr>
${parts.map(([, x]) => x.html).join('\n')}
<tr><td style="padding:0 0 26px"></td></tr>
</table>
</td></tr>
<tr>${td([
      phone ? `📞 <span dir="ltr" style="white-space:nowrap;unicode-bidi:isolate">${esc(phone)}</span>${ctx.contacts?.phoneNote ? ` — ${esc(firstSentence(ctx.contacts.phoneNote, 90))}` : ''}` : '',
      ctx.siteUrl ? `<a href="${esc(ctx.siteUrl)}" target="_blank" dir="ltr" style="color:${p.muted};font-weight:800;text-decoration:underline;white-space:nowrap;unicode-bidi:isolate">${esc(ctx.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : '',
      unsub ? `<a href="${esc(ctx.unsubscribeUrl)}" target="_blank" style="color:${p.muted};text-decoration:underline">להסרה מרשימת התפוצה</a>` : '',
    ].filter(Boolean).join(' &nbsp;·&nbsp; ') + (o.show.unsubscribe ? `<br><span>המייל הזה נשלח כי נרשמתם לרשימת התפוצה של ${esc(name)}.</span>` : ''), `padding:22px 12px 0;text-align:center;font-family:${F.sans};font-size:12px;font-weight:700;line-height:1.9;color:${p.muted}`, 'align="center"')}</tr>
</table>
</td></tr>
</table>`;

    const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="${p.dark ? 'dark' : 'light'}">
<meta name="supported-color-schemes" content="${p.dark ? 'dark' : 'light'}">
<title>${esc(subject)}</title>
<link href="${fontCss}" rel="stylesheet">
<style>
body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
a { color: inherit; }
@media only screen and (max-width: 620px) {
  .w { width: 100% !important; }
  .p { padding-left: 20px !important; padding-right: 20px !important; }
  .h1 { font-size: ${Math.round(F.size * 0.78)}px !important; }
  .hc { max-width: 100% !important; }
  .bts { width: 100% !important; }
  .bt { display: block !important; width: 100% !important; padding: 0 0 10px !important; }
  .bt a { display: block !important; }
}
</style>
</head>
<body dir="rtl" bgcolor="${p.bg}" style="margin:0;padding:0;background:${p.bg}">
${bodyHtml}
</body>
</html>`;

    const text = [
      `🎙️ ${kicker}`, headline, meta.join(' · '), '',
      ...parts.flatMap(([, x]) => [x.text, '']),
      phone ? `📞 ${phone}` : '', ctx.siteUrl || '',
      unsub ? `להסרה מרשימת התפוצה: ${ctx.unsubscribeUrl}` : '',
    ].join('\n').replace(/\n{3,}/g, '\n\n').trim();

    const size = utf8(html).length;
    const cta = !active.includes('cta') ? 'off' : ctaOk ? 'ok' : !ctaLabel && !ctaUrl ? 'empty' : !ctaLabel ? 'no-label' : 'bad-url';
    return {
      subject, preheader, html, bodyHtml: `<style>@import url("${fontCss}");</style>${bodyHtml}`, text, palette: p, size,
      report: {
        kind, blocks: parts.map(([id]) => id), leftover: [...report.leftover], empty: [...report.empty], preheaderAuto: !customPre,
        links: [...bodyHtml.matchAll(/href="([^"]*)"/g)].map((m) => unesc(m[1])),
        images: [...bodyHtml.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => unesc(m[1])),
        words: text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length,
        bodyWords: plain(introText).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length,
        hasUnsubscribe: unsub, descEmpty: kind === 'episode' && active.includes('description') && !plain(descText).trim(), items: items.length, cta,
      },
    };
  }

  /* ---------- הבדיקה לפני יצירה ---------- */

  const SPAM = ['חינם', 'בחינם', 'מבצע', 'הנחה', 'זכייה', 'זכיתם', 'פרס כספי', 'דחוף', 'לחצו כאן', 'הזדמנות אחרונה', 'FREE', 'WINNER', '$$$', '100%'];
  const EMOJI = /\p{Extended_Pictographic}/gu;
  const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
  /**
   * mail: מה ש־build() מחזיר. info: { live, mode, recipients, limit, typos:[{email,fix}], risky:[] }
   * → [{ level: 'error'|'warn'|'info'|'ok', id, text, fix? }] — fix: הלשונית בעורך שבה מתקנים.
   */
  function audit(mail, info = {}) {
    const out = [], add = (level, id, text, fix) => out.push({ level, id, text, ...(fix ? { fix } : {}) });
    const r = mail.report || {}, s = String(mail.subject || '').trim();
    if (!s) add('error', 'subject', 'אין נושא למייל.', 'content');
    else {
      if (s.length > 70) add('warn', 'subject-long', `הנושא ארוך (${s.length} תווים) — בטלפון רואים רק כ־40 התווים הראשונים.`, 'content');
      else if (s.length < 10) add('warn', 'subject-short', 'הנושא קצר מאוד — כמה מילים על התוכנית עוזרות לפתוח את המייל.', 'content');
      else add('ok', 'subject', `אורך הנושא טוב (${s.length} תווים).`);
      if ((s.match(EMOJI) || []).length > 2) add('warn', 'subject-emoji', 'יותר משני אימוג\'ים בנושא נראה כמו פרסומת.', 'content');
      if (/[!?]{2,}/.test(s) || /\b[A-Z]{5,}\b/.test(s)) add('warn', 'subject-shout', 'סימני קריאה כפולים או מילים באותיות גדולות בנושא נראים כמו פרסומת — ומגיעים לספאם.', 'content');
      const spam = SPAM.filter((w) => s.toLowerCase().includes(w.toLowerCase()));
      if (spam.length) add('warn', 'spam', `בנושא יש מילים שמסנני ספאם אוהבים: ${spam.join(', ')}.`, 'content');
    }
    if (r.preheaderAuto === false && String(mail.preheader).trim() === s) add('info', 'preheader', 'שורת התצוגה המקדימה זהה לנושא — אפשר לנצל אותה למשפט נוסף.', 'content');
    if (r.leftover?.length) add('error', 'tokens', `משתנים שלא זוהו: ${r.leftover.join(' ')} — הם יופיעו במייל כמו שהם.`, 'content');
    if (r.empty?.length) add('warn', 'tokens-empty', `משתנים ריקים בתוכנית הזו: ${r.empty.join(' ')} — במקומם לא ייכתב כלום.`, 'content');
    if (mail.size > 102 * 1024) add('error', 'size', `המייל גדול (${kb(mail.size)}) — ג'ימייל מקצר מיילים מעל 102 KB ומסתיר את הסוף, כולל שורת ההסרה.`, 'content');
    else if (mail.size > 80 * 1024) add('warn', 'size', `המייל מתקרב לגבול של ג'ימייל (${kb(mail.size)} מתוך 102 KB).`, 'content');
    else add('ok', 'size', `גודל המייל ${kb(mail.size)} — ג'ימייל יציג אותו במלואו.`);
    const links = r.links || [];
    if (links.some((u) => !u || u === '#')) add('error', 'links-empty', 'יש כפתור או קישור בלי כתובת.', 'content');
    const insecure = [...new Set(links.filter((u) => /^http:\/\//i.test(u)))];
    if (insecure.length) add('warn', 'links-http', `קישורים בלי https (${insecure.length}) — חלק מתוכנות הדואר מזהירות עליהם.`, 'content');
    if ((r.images || []).some((u) => /^http:\/\//i.test(u))) add('warn', 'images-http', 'תמונה בכתובת http — ג\'ימייל עלול לא להציג אותה.', 'design');
    if (links.length > 30) add('warn', 'links-many', `הרבה קישורים במייל אחד (${links.length}) — מסנני ספאם חושדים בזה.`, 'content');
    if (r.cta === 'no-label') add('error', 'cta', 'לכפתור הנוסף יש קישור אבל אין לו טקסט.', 'content');
    if (r.cta === 'bad-url') add('error', 'cta', 'הקישור של הכפתור הנוסף לא תקין — הוא צריך להתחיל ב־https://', 'content');
    if (r.kind === 'episode' && r.descEmpty) add('info', 'desc', 'אין תיאור לתוכנית במייל — כמה משפטים על מה שהיה בה מביאים יותר מאזינים.', 'content');
    if (r.kind === 'note' && (r.bodyWords || 0) < 8) add('warn', 'body', 'ההודעה כמעט ריקה — כתבו בפתיחה מה רציתם לספר.', 'content');
    if (r.kind === 'digest' && (r.items || 0) < 2) add('warn', 'items', 'בסיכום יש פחות משתי תוכניות.', 'content');
    if (!r.hasUnsubscribe) add('warn', 'unsub', 'אין במייל קישור להסרה מהרשימה — מי שלא מוצא איך להסיר את עצמו מסמן "ספאם".', 'design');
    else add('ok', 'unsub', 'יש קישור להסרה מהרשימה.');
    if (info.live === false) add('warn', 'live', 'התוכנית עוד לא באתר — הקישורים יעבדו רק אחרי הפרסום. שלחו את הטיוטה אחרי שהתוכנית עולה.', 'content');
    if (info.mode !== 'me') {
      const n = Number(info.recipients) || 0;
      if (!n) add('error', 'recipients', 'אין נמענים — טענו את רשימת התפוצה, ייבאו קובץ או הדביקו כתובות.', 'people');
      else {
        add('ok', 'recipients', `${n.toLocaleString('he-IL')} נמענים, כולם בעותק מוסתר (Bcc).`);
        if (info.limit && n > info.limit) add('warn', 'limit', `יותר נמענים מהמגבלה היומית של ג'ימייל (${info.limit.toLocaleString('he-IL')}) — שלחו את הטיוטות במשך ${Math.ceil(n / info.limit)} ימים.`, 'people');
      }
      if (info.typos?.length) add('warn', 'typos', `${info.typos.length === 1 ? 'כתובת אחת נראית שגויה' : `${info.typos.length} כתובות נראות שגויות`} (למשל ${info.typos[0].email} ← ${info.typos[0].fix}).`, 'people');
      if (info.risky?.length) add('info', 'risky', `${info.risky.length === 1 ? 'כתובת אחת לא מקבלת' : `${info.risky.length} כתובות לא מקבלות`} מיילים (no-reply או כתובת לדוגמה): ${info.risky.slice(0, 3).join(', ')}.`, 'people');
    }
    const min = Math.max(1, Math.round((r.words || 0) / 200));
    add('info', 'reading', `זמן קריאה: ${min === 1 ? 'כדקה' : `כ־${min} דקות`} (${(r.words || 0).toLocaleString('he-IL')} מילים).`);
    const rank = { error: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /** הצעות לנושא, לפי סוג המייל והתוכנית */
  function suggestSubjects(episode, ctx = {}, kind = 'episode', items = []) {
    const name = ctx.siteName || 'ראש בראש', out = [];
    if (kind === 'digest') {
      const n = items.length, first = items.slice(0, 2).map((i) => i.title).filter(Boolean);
      out.push(`🎧 ${n} תוכניות ב${name} שכדאי לשמוע`, `פספסתם? ${n === 1 ? 'התוכנית האחרונה' : `${n} התוכניות האחרונות`} של ${name}`, first.length ? `${first.join(', ')} — ועוד ב${name}` : '', `הסיכום של ${name}: כל התוכניות האחרונות במקום אחד`, `🎙️ מה היה ב${name} לאחרונה`);
    } else if (kind === 'note') {
      out.push(`📣 עדכון מ${name}`, `חדש ב${name}`, `הודעה למאזיני ${name}`, `✦ ${name}: מה חדש אצלנו`);
    } else {
      const e = episode || {}, title = label(e), g = (e.guests || []).filter(Boolean);
      out.push(`🎙️ תוכנית חדשה ב${name}: ${title}`, `${title} — התוכנית החדשה של ${name}`, `עלתה עכשיו: ${title} 🎧`, e.number != null && e.number !== '' ? `תוכנית ${e.number}: ${title}` : '', g.length ? `${title}, עם ${g.slice(0, 2).join(' ו')}` : '', `🎧 להאזנה ולהורדה: ${title}`, ctx.dateText ? `${title} · ${ctx.dateText}` : '');
    }
    return [...new Set(out.filter(Boolean))];
  }

  /* ---------- כתובות ---------- */

  const EMAILS = /[^\s@<>,;:"'()[\]]+@[^\s@<>,;:"'()[\]]+\.[^\s@<>,;:"'()[\]]+/g;
  // סימני כיוון ותווים בלתי נראים (מוואטסאפ, מוורד, מטקסט בעברית) — אחרת הם נדבקים לכתובת ושוברים את כותרת ה־Bcc
  const MARKS = /[​‎‏‪-‮⁦-⁩﻿]/g;
  const unmark = (s) => String(s ?? '').replace(MARKS, '');
  /** כל כתובות המייל שבטקסט — רשימה מודבקת, קובץ CSV מאקסל ("שם",כתובת), או "שם <כתובת>".
      באותיות קטנות, בלי כפילויות, בסדר שבו הופיעו. */
  function parseEmails(text) {
    const out = new Set();
    for (const m of unmark(text || '').matchAll(EMAILS)) out.add(m[0].replace(/\.+$/, '').toLowerCase());
    return [...out];
  }
  const KNOWN = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.il', 'ymail.com', 'hotmail.com', 'hotmail.co.il', 'outlook.com', 'outlook.co.il', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'mail.com', 'email.com', 'gmx.com', 'walla.co.il', 'walla.com', 'netvision.net.il', '012.net.il', 'bezeqint.net', 'zahav.net.il', 'smile.net.il', 'barak.net.il', 'inter.net.il', 'nana10.co.il', 'protonmail.com', 'proton.me']);
  const COMMON = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'live.com', 'googlemail.com', 'walla.co.il', 'walla.com', 'bezeqint.net', 'netvision.net.il', 'zahav.net.il'];
  const FIXES = { 'gmail.co.il': 'gmail.com', 'gmail.il': 'gmail.com', 'walla.il': 'walla.co.il', 'walla.co.l': 'walla.co.il' };
  /** מרחק עריכה (כולל החלפת שתי אותיות סמוכות) */
  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  /** הכתובת כנראה התכוונו אליה (gmial.com → gmail.com), או '' */
  function fixAddress(email) {
    const at = String(email).lastIndexOf('@'); if (at < 1) return '';
    const local = email.slice(0, at), dom = email.slice(at + 1).toLowerCase();
    if (KNOWN.has(dom)) return '';
    if (FIXES[dom]) return `${local}@${FIXES[dom]}`;
    let best = '', bd = 9;
    for (const c of COMMON) { const x = distance(dom, c); if (x < bd) { bd = x; best = c; } }
    if (best && bd <= (dom.length > 9 ? 2 : 1)) return `${local}@${best}`;
    const tld = dom.replace(/\.(con|cmo|ocm|cpm|vom|xom|comm|coom)$/, '.com');
    return tld !== dom ? `${local}@${tld}` : '';
  }
  const RISKY_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)$/i;
  const RISKY_DOMAIN = /(^|\.)(example\.(com|org|net)|test\.com|mailinator\.com)$/i;
  /** בדיקת הרשימה: כתובות עם טעות הקלדה בדומיין (והתיקון), כתובות שלא מקבלות דואר, ומה הדומיינים הנפוצים */
  function checkAddresses(list) {
    const typos = [], risky = [], domains = new Map();
    for (const email of list || []) {
      const at = email.lastIndexOf('@'), dom = email.slice(at + 1);
      domains.set(dom, (domains.get(dom) || 0) + 1);
      if (RISKY_LOCAL.test(email.slice(0, at)) || RISKY_DOMAIN.test(dom)) { risky.push(email); continue; }
      const fix = fixAddress(email);
      if (fix && fix !== email) typos.push({ email, fix });
    }
    return { typos, risky, domains: [...domains.entries()].sort((a, b) => b[1] - a[1]) };
  }
  /** כמה נמענים ג'ימייל מרשה ביום: חשבון רגיל 500, Google Workspace (דומיין משלכם) 2,000 */
  const dailyLimit = (email) => (/@(gmail|googlemail)\.com$/i.test(String(email || '')) ? 500 : 2000);

  /* ---------- MIME: מה ש־Gmail מקבל ---------- */

  const utf8 = (s) => new TextEncoder().encode(String(s));
  function b64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const base64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
  /** כותרת עם עברית → "encoded words" (RFC 2047); ASCII נשאר כמו שהוא. כל מילה מקודדת
      מוגבלת ל־75 תווים, ולכן נושא ארוך מתחלק לכמה (בלי לחתוך אות או אימוג'י באמצע). */
  function encodeWord(s) {
    s = String(s);
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    const words = []; let cur = '';
    for (const ch of s) {
      if (utf8(cur + ch).length > 45) { words.push(cur); cur = ''; }
      cur += ch;
    }
    if (cur) words.push(cur);
    return words.map((w) => `=?UTF-8?B?${b64(utf8(w))}?=`).join('\r\n ');
  }
  /** כותרת נמענים מקופלת: כתובת בכל שורה (שורה של כותרת מוגבלת ל־998 תווים) */
  const addressHeader = (name, list) => (list.length ? `${name}: ${list.join(',\r\n ')}` : null);
  /** ההודעה כ־MIME. unsent: קובץ ‎.eml שנפתח באאוטלוק כהודעה חדשה שעוד לא נשלחה. */
  function mime({ to = [], cc = [], bcc = [], replyTo = '', subject = '', html = '', text = '', unsubscribe = '', unsent = false }) {
    const boundary = `rosh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return [
      unsent ? 'X-Unsent: 1' : null,
      addressHeader('To', to), addressHeader('Cc', cc), addressHeader('Bcc', bcc),
      replyTo ? `Reply-To: ${replyTo}` : null,
      `Subject: ${encodeWord(subject)}`,
      /^https?:\/\/\S+$/.test(unsubscribe) ? `List-Unsubscribe: <${unsubscribe}>` : null,
      'Content-Language: he',
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(utf8(text))),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(utf8(html))),
      `--${boundary}--`,
      '',
    ].filter((l) => l !== null).join('\r\n');
  }
  const raw = (msg) => base64url(utf8(mime(msg)));
  /** [a,b,c,d,e], 2 → [[a,b],[c,d],[e]] */
  function chunk(list, size) {
    const n = Math.max(1, Math.floor(Number(size) || 1)), out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  window.RoshMail = {
    STYLES, KINDS, BLOCKS, DEFAULT_BLOCKS, FONT_SETS, SHAPES, TOKENS, FONTS_URL,
    defaults, build, audit, blocksFor, suggestSubjects, rich, plain, tokens,
    raw, mime, chunk, parseEmails, unmark, checkAddresses, fixAddress, dailyLimit, encodeWord, base64url,
    inkFor, contrast, hslHex, palette, own,
  };
})();
