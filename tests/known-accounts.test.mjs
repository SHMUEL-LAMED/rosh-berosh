import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_ACCOUNTS_KEY, MAX_KNOWN_ACCOUNTS, normalizeKnownAccounts, readKnownAccounts, rememberAccount, writeKnownAccounts } from "../app/known-accounts.js";

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size }; };

test("כניסה זוכרת את החשבון במכשיר: כתובת, שם ותמונה בלבד — בלי סשן", () => {
  const storage = memory();
  const user = { email: "Voter@Example.com", name: "מצביע", picture: "https://lh3.example/p.jpg", isAdmin: true, token: "secret" };
  writeKnownAccounts(storage, rememberAccount(readKnownAccounts(storage), user, 1000));
  assert.deepEqual(readKnownAccounts(storage), [{ email: "voter@example.com", name: "מצביע", picture: "https://lh3.example/p.jpg", at: 1000 }]);
  assert.doesNotMatch(storage.getItem(KNOWN_ACCOUNTS_KEY), /secret|isAdmin/, "שום דבר מעבר לזיהוי לא נשמר");
});

test("עד שלושה חשבונות, האחרון שנכנס ראשון; כניסה חוזרת רק מעלה לראש", () => {
  let list = [];
  for (const [i, n] of [1, 2, 3, 4, 2].entries()) list = rememberAccount(list, { email: `a${n}@example.com`, name: `חשבון ${n}` }, i);
  assert.equal(MAX_KNOWN_ACCOUNTS, 3);
  assert.deepEqual(list.map((a) => a.email), ["a2@example.com", "a4@example.com", "a3@example.com"]);
  assert.equal(list[0].at, 4, "הכניסה החוזרת מעדכנת את הזמן");
});

test("רשומות פגומות באחסון לא מפילות את הרשימה", () => {
  const storage = memory();
  storage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify([null, 7, { name: "בלי כתובת" }, { email: "ok@example.com", name: 5, picture: null, at: "x" }, { email: "b@example.com" }, { email: "c@example.com" }, { email: "d@example.com" }]));
  assert.deepEqual(readKnownAccounts(storage), [{ email: "ok@example.com", name: "", picture: "", at: 0 }, { email: "b@example.com", name: "", picture: "", at: 0 }, { email: "c@example.com", name: "", picture: "", at: 0 }]);
  storage.setItem(KNOWN_ACCOUNTS_KEY, "{not json");
  assert.deepEqual(readKnownAccounts(storage), []);
  assert.deepEqual(normalizeKnownAccounts({ email: "x@example.com" }), []);
  assert.deepEqual(rememberAccount([{ email: "a@example.com" }], { email: "no-at" }), [{ email: "a@example.com", name: "", picture: "", at: 0 }], "משתמש בלי כתובת תקינה לא נוסף");
});

test("אחסון חסום (מצב פרטי) לא מפיל את הדף, ורשימה ריקה מוחקת את המפתח", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.deepEqual(readKnownAccounts(blocked), []);
  assert.doesNotThrow(() => writeKnownAccounts(blocked, [{ email: "a@example.com", name: "", picture: "", at: 1 }]));
  const storage = memory();
  writeKnownAccounts(storage, rememberAccount([], { email: "a@example.com" }));
  writeKnownAccounts(storage, []);
  assert.equal(storage.getItem(KNOWN_ACCOUNTS_KEY), null);
});
