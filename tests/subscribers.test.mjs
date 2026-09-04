import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isValidEmail, normalizeEmail, normalizeName, parseSubscriberLine, parseSubscriberList } from "../worker/subscribers.js";

test("כתובת מנורמלת לאותיות קטנות ובלי רווחים", () => {
  assert.equal(normalizeEmail("  Shmuel@Example.COM  "), "shmuel@example.com");
  assert.equal(normalizeEmail(null), "");
});

test("ולידציה מקבלת כתובות תקינות ודוחה זבל", () => {
  assert.ok(isValidEmail("a@b.co"));
  assert.ok(isValidEmail("shmuel.levi+news@mail.example.co.il"));
  assert.ok(!isValidEmail("shmuel@example"));
  assert.ok(!isValidEmail("@example.com"));
  assert.ok(!isValidEmail("שם בלי כתובת"));
  assert.ok(!isValidEmail(`${"a".repeat(250)}@example.com`));
});

test("שם מתנקה מרווחים כפולים ונחתך", () => {
  assert.equal(normalizeName("  שמואל   ליווי  "), "שמואל ליווי");
  assert.equal(normalizeName("x".repeat(200)).length, 120);
});

test("שורה בודדת מנותחת בכל הפורמטים", () => {
  assert.deepEqual(parseSubscriberLine("a@b.com"), { email: "a@b.com", name: "" });
  assert.deepEqual(parseSubscriberLine("שמואל,a@b.com"), { email: "a@b.com", name: "שמואל" });
  assert.deepEqual(parseSubscriberLine("a@b.com;שמואל"), { email: "a@b.com", name: "שמואל" });
  assert.deepEqual(parseSubscriberLine('"שמואל" <A@B.com>'), { email: "a@b.com", name: "שמואל" });
  assert.equal(parseSubscriberLine("שורה בלי כתובת"), null);
  assert.equal(parseSubscriberLine("   "), null);
});

test("רשימה מיובאת מסירה כפילויות ושומרת על שם קיים", () => {
  const { entries, skipped } = parseSubscriberList([
    "email,name",
    "a@b.com",
    "A@B.COM,שמואל",
    "c@d.com,יוסי",
    "שורה ריקה מכתובת",
    "",
  ].join("\n"));
  assert.deepEqual(entries, [
    { email: "a@b.com", name: "שמואל" },
    { email: "c@d.com", name: "יוסי" },
  ]);
  // שורת הכותרת ושורת הטקסט אינן מכילות כתובת, ולכן שתיהן נספרות כדילוג.
  assert.equal(skipped, 2);
});

test("רשימה בלי אף כתובת תקינה חוזרת ריקה", () => {
  const { entries, skipped } = parseSubscriberList("שלום\nעולם");
  assert.deepEqual(entries, []);
  assert.equal(skipped, 2);
});

// רגרסיה: `adminApi` מחזיר 404 לכל נתיב שאינו מוכר לו, ולכן הוא חייב לרוץ
// אחרי מודול רשימת התפוצה. כשהסדר התהפך, לשונית הניהול נכשלה בטעינה.
test("ניתוב /api/admin/subscribers קודם לנתב הניהול הכללי", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const subscribers = worker.indexOf('startsWith("/api/admin/subscribers")');
  const catchAll = worker.indexOf('startsWith("/api/admin/")) return adminApi');
  assert.ok(subscribers !== -1, "חסר ניתוב ל-/api/admin/subscribers");
  assert.ok(catchAll !== -1, "חסר הנתב הכללי של הניהול");
  assert.ok(subscribers < catchAll, "מודול רשימת התפוצה חייב להיבדק לפני הנתב הכללי");
});
