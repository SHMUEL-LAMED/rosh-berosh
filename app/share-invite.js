/**
 * ההזמנה למצעד: נוסח טקסט, מייל מעוצב וקישורים לפתיחת מייל חדש.
 * מודול טהור, בלי DOM, כדי שהבדיקות יוכלו לבנות את ההזמנה ישירות.
 *
 * הדרך הראשית היא מייל חדש שההזמנה כבר כתובה בו (inviteText בגוף ההודעה),
 * בלי להעתיק ובלי הרשאות. קישור mailto: או חלון כתיבה של Gmail נושאים טקסט
 * פשוט בלבד, ולכן הגרסה המעוצבת (inviteEmailHtml) היא אפשרות נוספת: מועתקת
 * ללוח כ־HTML ומודבקת. העיצוב שלה כולו בסגנונות inline ובטבלאות, בלי מעברי
 * צבע ובלי CSS חיצוני, כי כך תוכנות הדואר שומרות אותו — גם כשמדביקים בטלפון.
 */

export const SHARE_SUBJECT = "הזמנה למצעד האלבומים של ראש בראש 🎶";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

const FEATURES = [
  ["💿", "האלבומים הגדולים", "בוחרים את האהובים עליכם"],
  ["🎵", "השירים", "מכל אלבום, השיר שהכי נגע בכם"],
  ["🎤", "הזמרים", "הקולות שליוו אתכם לאורך השנים"],
];

/**
 * נוסח הטקסט: גוף המייל שנפתח בלחיצה אחת, והטקסט שנשלח בשיתוף מהמכשיר.
 * הקישור בשורה משלו, כדי שכל תוכנת דואר תהפוך אותו לקישור לחיץ. במייל שורת
 * הכותרת מיותרת (הנושא כבר אומר אותה), ובלעדיה קישור ה־mailto: נשאר קצר
 * מ־2000 תווים — יש תוכנות דואר בווינדוס שקוטעות קישור ארוך יותר.
 */
export function inviteText(url, { headline = true } = {}) {
  return [
    ...(headline ? ["✦ הזמנה למצעד האלבומים של ראש בראש ✦", ""] : []),
    "שלום,",
    "רציתי להזמין אתכם להשתתף במצעד הגדול: 25 שנות מוזיקה יהודית, והקול שלכם קובע מי יגיע לפסגה!",
    "",
    ...FEATURES.map(([icon, title, text]) => `${icon} ${title} — ${text}`),
    "",
    "👈 להצבעה במצעד:",
    url,
    "",
    "ההצבעה לוקחת כמה דקות, ואפשר להאזין לשירים לפני שבוחרים 🎧",
  ].join("\n");
}

/**
 * המייל המעוצב, מוכן להדבקה בגוף ההודעה. הכתובת היא כתובת האתר שממנו משתפים.
 *
 * הדבקה באפליקציות דואר בטלפון (Outlook, Gmail) כותבת את ההודעה מחדש: גופן, גודל
 * וצבע של div/p מוחלפים בברירת המחדל (טקסט שחור 12pt — הכותרת נעלמת על הרקע הכהה),
 * ו־background של div/table נמחק. מה שנשמר: עיצוב של רכיבי שורה (span, a, b) ורקע של
 * תא עם bgcolor. לכן כל טקסט עטוף ב־span שנושא את הגופן, הגודל והצבע, וכל רקע יושב
 * על תא (bgcolor ו־background-color), גם הרקע של הדף והכרטיס.
 */
export function inviteEmailHtml(url) {
  const site = new URL(url);
  const href = escapeHtml(site.href);
  const logo = escapeHtml(new URL("/badge-small.png", site).href);
  const host = escapeHtml(site.host);
  const text = (content, style) => `<span style="font-family:Arial,Helvetica,sans-serif;${style}">${content}</span>`;
  const rows = FEATURES.map(([icon, title, body]) => `<tr>
<td width="46" valign="middle" style="width:46px;padding:7px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="#f5edd4" style="width:38px;height:38px;border-radius:19px;background-color:#f5edd4;text-align:center">${text(icon, "font-size:19px;line-height:38px;color:#2b2340")}</td></tr></table></td>
<td valign="middle" style="padding:7px 12px 7px 0;text-align:right;direction:rtl"><div>${text(`<b>${title}</b>`, "font-size:16px;font-weight:bold;color:#2b2340")}</div><div style="margin-top:2px">${text(body, "font-size:14px;color:#746a7d")}</div></td>
</tr>`).join("\n");
  return `<div dir="rtl" style="direction:rtl;text-align:right;margin:0;padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse"><tr><td align="center" bgcolor="#f6f1e3" style="padding:22px 10px;background-color:#f6f1e3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto;border-collapse:separate">
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e0cf97;border-radius:20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
<tr><td align="center" bgcolor="#241b42" style="padding:30px 24px 28px;background-color:#241b42;border-radius:19px 19px 0 0;text-align:center">
<img src="${logo}" width="96" height="96" alt="ראש בראש" style="display:block;width:96px;height:96px;margin:0 auto 14px;border:0">
<div style="letter-spacing:2px">${text("<b>✦ הזמנה אישית למצעד ✦</b>", "font-size:13px;font-weight:bold;color:#ead47a;letter-spacing:2px")}</div>
<div style="margin-top:8px;line-height:1.25">${text("<b>מצעד האלבומים של ראש בראש</b>", "font-size:30px;font-weight:bold;line-height:1.25;color:#ffffff")}</div>
<div style="margin-top:8px">${text("25 שנות מוזיקה יהודית — והקול שלכם קובע", "font-size:16px;color:#f2e8bd")}</div>
</td></tr>
<tr><td bgcolor="#ffffff" style="padding:26px 28px 6px;text-align:right;direction:rtl;background-color:#ffffff">
<div style="margin:0 0 10px;line-height:1.7">${text("שלום,", "font-size:17px;line-height:1.7;color:#2b2340")}</div>
<div style="margin:0 0 16px;line-height:1.7">${text("רציתי להזמין אתכם להשתתף במצעד הגדול של ראש בראש. בוחרים יחד את המוזיקה הכי אהובה של 25 השנים האחרונות, והקול שלכם קובע מי יגיע לפסגה:", "font-size:17px;line-height:1.7;color:#2b2340")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
${rows}
</table>
</td></tr>
<tr><td align="center" bgcolor="#ffffff" style="padding:22px 28px 10px;text-align:center;background-color:#ffffff">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr><td align="center" bgcolor="#b89530" style="padding:16px 40px;border-radius:14px;background-color:#b89530">
<a href="${href}" target="_blank" style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;text-decoration:none">${text("<b>להצבעה במצעד ←</b>", "font-size:19px;font-weight:bold;color:#ffffff")}</a>
</td></tr></table>
<div style="margin:14px 0 0;line-height:1.6">${text("ההצבעה לוקחת כמה דקות, ואפשר להאזין לשירים לפני שבוחרים.", "font-size:13px;line-height:1.6;color:#7a7088")}</div>
</td></tr>
<tr><td align="center" bgcolor="#ffffff" style="padding:18px 24px 22px;text-align:center;border-top:1px solid #efe6cf;line-height:1.7;background-color:#ffffff;border-radius:0 0 19px 19px">
<a href="${href}" target="_blank" style="color:#806515;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;text-decoration:none">${text(`<b>${host}</b>`, "font-size:12px;font-weight:bold;color:#806515")}</a><br>${text("ראש בראש · מצעד 25 שנות מוזיקה יהודית", "font-size:12px;line-height:1.7;color:#8a8070")}
</td></tr>
</table>
</td></tr>
</table>
</td></tr></table>
</div>`;
}

/** מייל חדש בתוכנת הדואר או באפליקציה. בלי body — גוף ריק שמחכה להדבקה. */
export function mailtoLink({ body } = {}) {
  const params = [`subject=${encodeURIComponent(SHARE_SUBJECT)}`];
  if (body) params.push(`body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`);
  return `mailto:?${params.join("&")}`;
}

/** חלון כתיבה חדש ב־Gmail בדפדפן — כל המצביעים מתחברים עם חשבון Google. */
export function gmailComposeLink({ body } = {}) {
  const params = new URLSearchParams({ view: "cm", fs: "1", su: SHARE_SUBJECT });
  if (body) params.set("body", body);
  return `https://mail.google.com/mail/?${params.toString()}`;
}
