/**
 * ההזמנה למצעד: מייל מעוצב, נוסח טקסט וקישורים לפתיחת מייל חדש.
 * מודול טהור, בלי DOM, כדי שהבדיקות יוכלו לבנות את ההזמנה ישירות.
 *
 * קישור mailto: או חלון כתיבה של Gmail נושאים טקסט פשוט בלבד, ולכן המייל
 * המעוצב מועתק ללוח כ־HTML ומודבק בגוף ההודעה. העיצוב כולו בסגנונות inline
 * ובטבלאות, בלי מעברי צבע ובלי CSS חיצוני, כי כך תוכנות הדואר שומרות אותו.
 */

export const SHARE_SUBJECT = "הזמנה למצעד האלבומים של ראש בראש 🎶";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

const FEATURES = [
  ["💿", "האלבומים הגדולים", "בוחרים את האהובים עליכם"],
  ["🎵", "השירים", "מכל אלבום, השיר שהכי נגע בכם"],
  ["🎤", "הזמרים", "הקולות שליוו אתכם לאורך השנים"],
];

/** נוסח הטקסט: גוף המייל כשאין העתקה מעוצבת, והטקסט שנשלח בשיתוף. */
export function inviteText(url) {
  return [
    "✦ הזמנה אישית למצעד האלבומים של ראש בראש ✦",
    "25 שנות מוזיקה יהודית — והקול שלכם קובע!",
    "",
    ...FEATURES.map(([icon, title, text]) => `${icon} ${title} — ${text}`),
    "",
    `👈 להצבעה: ${url}`,
    "",
    "ההצבעה לוקחת כמה דקות, ואפשר להאזין לשירים לפני שבוחרים.",
  ].join("\n");
}

/** המייל המעוצב, מוכן להדבקה בגוף ההודעה. הכתובת היא כתובת האתר שממנו משתפים. */
export function inviteEmailHtml(url) {
  const site = new URL(url);
  const href = escapeHtml(site.href);
  const logo = escapeHtml(new URL("/badge-small.png", site).href);
  const host = escapeHtml(site.host);
  const rows = FEATURES.map(([icon, title, text]) => `<tr>
<td width="46" valign="middle" style="width:46px;padding:7px 0"><div style="width:38px;height:38px;line-height:38px;border-radius:19px;background:#f5edd4;text-align:center;font-size:19px">${icon}</div></td>
<td valign="middle" style="padding:7px 12px 7px 0;text-align:right;direction:rtl"><div style="font-size:16px;font-weight:bold;color:#2b2340">${title}</div><div style="margin-top:2px;font-size:14px;color:#746a7d">${text}</div></td>
</tr>`).join("\n");
  return `<div dir="rtl" style="direction:rtl;text-align:right;margin:0;padding:22px 10px;background:#f6f1e3;font-family:Arial,Helvetica,sans-serif;color:#2b2340">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto;border-collapse:separate;background:#ffffff;border:1px solid #e0cf97;border-radius:20px">
<tr><td align="center" bgcolor="#241b42" style="padding:30px 24px 28px;background:#241b42;border-radius:19px 19px 0 0;text-align:center">
<img src="${logo}" width="96" height="96" alt="ראש בראש" style="display:block;width:96px;height:96px;margin:0 auto 14px;border:0">
<div style="color:#ead47a;font-size:13px;font-weight:bold;letter-spacing:2px">✦ הזמנה אישית למצעד ✦</div>
<div style="margin-top:8px;color:#ffffff;font-size:30px;font-weight:bold;line-height:1.25">מצעד האלבומים של ראש בראש</div>
<div style="margin-top:8px;color:#f2e8bd;font-size:16px">25 שנות מוזיקה יהודית — והקול שלכם קובע</div>
</td></tr>
<tr><td style="padding:26px 28px 6px;text-align:right;direction:rtl">
<p style="margin:0 0 10px;font-size:17px;line-height:1.7;color:#2b2340">שלום,</p>
<p style="margin:0 0 16px;font-size:17px;line-height:1.7;color:#2b2340">רציתי להזמין אתכם להשתתף במצעד הגדול של ראש בראש. בוחרים יחד את המוזיקה הכי אהובה של 25 השנים האחרונות, והקול שלכם קובע מי יגיע לפסגה:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
${rows}
</table>
</td></tr>
<tr><td align="center" style="padding:22px 28px 10px;text-align:center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr><td align="center" bgcolor="#b89530" style="border-radius:14px;background:#b89530">
<a href="${href}" target="_blank" style="display:inline-block;padding:16px 40px;font-size:19px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:14px">להצבעה במצעד ←</a>
</td></tr></table>
<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#7a7088">ההצבעה לוקחת כמה דקות, ואפשר להאזין לשירים לפני שבוחרים.</p>
</td></tr>
<tr><td align="center" style="padding:18px 24px 22px;text-align:center;border-top:1px solid #efe6cf;font-size:12px;line-height:1.7;color:#8a8070">
<a href="${href}" target="_blank" style="color:#806515;font-weight:bold;text-decoration:none">${host}</a><br>ראש בראש · מצעד 25 שנות מוזיקה יהודית
</td></tr>
</table>
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
