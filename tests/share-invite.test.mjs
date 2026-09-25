import assert from "node:assert/strict";
import test from "node:test";
import { statSync } from "node:fs";
import { SHARE_SUBJECT, gmailComposeLink, inviteEmailHtml, inviteText, mailtoLink } from "../app/share-invite.js";

const SITE = "https://rosh-berosh.example.com/";

test("המייל המעוצב מוביל להצבעה באתר שממנו שיתפו", () => {
  const html = inviteEmailHtml(SITE);
  assert.match(html, /<a href="https:\/\/rosh-berosh\.example\.com\/" target="_blank"[^>]*>להצבעה במצעד ←<\/a>/);
  assert.match(html, /<img src="https:\/\/rosh-berosh\.example\.com\/badge-small\.png"/, "הלוגו בכתובת מלאה, אחרת לא ייטען אצל הנמען");
  assert.match(html, /^<div dir="rtl" style="direction:rtl;text-align:right/);
  assert.match(html, />rosh-berosh\.example\.com<\/a>/);
});

// תוכנות דואר מסירות <style>, מחלקות ומעברי צבע: כל העיצוב חייב להיות inline ובצבעים אחידים.
test("המייל המעוצב בנוי כך שתוכנות הדואר שומרות את העיצוב", () => {
  const html = inviteEmailHtml(SITE);
  assert.doesNotMatch(html, /<style|class=|<script/);
  assert.doesNotMatch(html, /gradient/);
  assert.match(html, /<table role="presentation"/);
  assert.match(html, /bgcolor="#b89530"/, "כפתור ההצבעה צבוע גם בלי CSS");
});

test("כתובת עם תווים מיוחדים אינה שוברת את המייל", () => {
  const html = inviteEmailHtml(`${SITE}?a="><img src=x onerror=alert(1)>`);
  assert.doesNotMatch(html, /onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /"><img src=x/);
});

test("נוסח הטקסט: הקישור בשורה משלו, ובמייל בלי שורת הכותרת", () => {
  const text = inviteText(SITE);
  assert.match(text, /^✦ הזמנה למצעד האלבומים של ראש בראש ✦\n/);
  assert.match(text, /\n👈 להצבעה במצעד:\nhttps:\/\/rosh-berosh\.example\.com\/\n/, "a URL alone on its line becomes a link in every mail program");
  const mail = inviteText(SITE, { headline: false });
  assert.match(mail, /^שלום,\n/, "the subject already carries the headline");
  assert.ok(mail.includes("\nhttps://rosh-berosh.example.com/\n"));
  assert.doesNotMatch(text + inviteEmailHtml(SITE), /wa\.me|t\.me|whatsapp|telegram/i);
});

// יש תוכנות דואר בווינדוס שקוטעות קישור mailto: ארוך מ־2000 תווים, ועברית מקודדת תופסת שישה תווים לאות.
test("המייל שנפתח בלחיצה אחת: ההזמנה כבר בגוף ההודעה, בקישור קצר מ־2000 תווים", () => {
  const production = "https://rosh-berosh.smwlyqswkwt232.workers.dev/";
  const body = inviteText(production, { headline: false });
  const mailto = mailtoLink({ body });
  assert.ok(mailto.length < 2000, `mailto: ${mailto.length} תווים`);
  assert.equal(decodeURIComponent(mailto.split("&body=")[1]), body.replace(/\n/g, "\r\n"));
  assert.equal(new URL(gmailComposeLink({ body })).searchParams.get("body"), body);
});

test("קישורי המייל: גוף ריק להדבקת הגרסה המעוצבת, או ההזמנה כטקסט", () => {
  const subject = encodeURIComponent(SHARE_SUBJECT);
  assert.equal(mailtoLink(), `mailto:?subject=${subject}`);
  assert.equal(mailtoLink({ body: "א\nב" }), `mailto:?subject=${subject}&body=${encodeURIComponent("א\r\nב")}`);
  const gmail = new URL(gmailComposeLink());
  assert.equal(gmail.origin + gmail.pathname, "https://mail.google.com/mail/");
  assert.equal(gmail.searchParams.get("view"), "cm");
  assert.equal(gmail.searchParams.get("su"), SHARE_SUBJECT);
  assert.equal(gmail.searchParams.has("body"), false);
  assert.equal(new URL(gmailComposeLink({ body: inviteText(SITE) })).searchParams.get("body"), inviteText(SITE));
});

// הלוגו נטען אצל כל נמען של המייל; הקובץ המלא (badge.jpg) שוקל כמה מגה.
test("הלוגו של המייל קטן", () => {
  assert.ok(statSync(new URL("../public/badge-small.png", import.meta.url)).size < 150_000);
});
