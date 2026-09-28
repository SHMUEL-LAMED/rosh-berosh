import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * "מה מחכה לך" (/api/admin/inbox) והחיפוש המהיר בניהול.
 * הבדיקה נועדה לתפוס שגיאות זמן ריצה בנתיבי הניהול — כמו פונקציית עזר
 * שנקראת בלי שיובאה — שאינן נתפסות בבנייה, כי תיקיית `worker` אינה עוברת tsc.
 */

// עטיפת D1 מעל node:sqlite. D1 מחזיר {results} ל-all ושורה בודדת ל-first.
function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    // D1 מחזיר `results` גם ל-`batch` וגם ל-`all`, גם למשפטי כתיבה.
    async all() {
      const prepared = db.prepare(sql);
      try { return { results: prepared.all(...values), success: true }; }
      catch { return { results: [], success: true, meta: prepared.run(...values) }; }
    },
    async first(column) {
      const row = db.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] : row;
    },
    async run() { return this.all(); },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) { return Promise.all(statements.map((item) => item.all())); },
  };
}

const media = {
  async get() { return null; },
  async put() {},
  async delete() {},
  async list() { return { objects: [] }; },
};

async function sessionCookie(db, email, token = "test-session-token") {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, "sub-1", email, "מנהל", null, Math.floor(Date.now() / 1000) + 3600);
  return `rosh_session=${token}`;
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function setup() {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/admin/overview"), env, ctx);
  // אתר התוכניות בונה את הטבלאות שלו בבקשה הראשונה אליו
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  const cookie = await sessionCookie(db, "admin@example.com");
  const inbox = async (who = cookie) => worker.fetch(new Request("http://localhost/api/admin/inbox", { headers: who ? { cookie: who } : {} }), env, ctx);
  return { worker, db, env, cookie, inbox };
}

const israelNow = (offsetHours = 0) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(Date.now() + offsetHours * 3600000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

test("the inbox counts unread messages, pending comments, an unpublished draft and upcoming scheduled episodes", async () => {
  const { db, inbox } = await setup();
  let body = await (await inbox()).json();
  assert.equal(body.messagesUnread, 0);
  assert.equal(body.commentsPending, 0);
  assert.equal(body.draft, null);
  assert.ok(Array.isArray(body.episodes) && body.episodes.length > 0, "the seeded programmes are listed for search");

  db.prepare("INSERT INTO program_messages (id,name,email,text) VALUES ('m1','א','a@x.com','שלום'),('m2','ב','b@x.com','היי')").run();
  db.prepare("UPDATE program_messages SET read_at=unixepoch() WHERE id='m2'").run();
  db.prepare("INSERT INTO program_comments (id,episode_id,name,text,status) VALUES ('c1','e','א','יפה','pending'),('c2','e','ב','מעולה','approved')").run();
  db.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('draft','{}',unixepoch())").run();
  const episode = (id, extra) => db.prepare("INSERT INTO program_episodes (id,slug,date,visible,data_json) VALUES (?,?,?,?,?)").run(id, id, "2026-09-01", extra.visible === false ? 0 : 1, JSON.stringify({ id, slug: id, title: `תוכנית ${id}`, date: "2026-09-01", ...extra }));
  episode("soon", { publishAt: israelNow(24) });
  episode("later", { publishAt: israelNow(24 * 30) });
  episode("past", { publishAt: israelNow(-24) });
  episode("hidden", { publishAt: israelNow(2), visible: false });

  body = await (await inbox()).json();
  assert.equal(body.messagesUnread, 1);
  assert.equal(body.commentsPending, 1);
  assert.ok(body.draft && body.draft.updatedAt > 0);
  assert.deepEqual(body.scheduled.map((item) => item.id), ["soon"], "only visible episodes due within two weeks");
  assert.equal(body.scheduledCount, 1);
  assert.ok(body.episodes.some((item) => item.id === "hidden" && item.visible === false), "hidden programmes are still searchable by admins");
});

test("the inbox is for administrators only", async () => {
  const { db, inbox } = await setup();
  assert.equal((await inbox(null)).status, 403);
  assert.equal((await inbox(await sessionCookie(db, "voter@example.com", "session-voter"))).status, 403);
});

test("quick search ignores niqqud, gershayim and dashes, needs every word, and puts name matches first", async () => {
  const { searchItems, normalizeSearch } = await import("../app/admin/admin-search.js");
  assert.equal(normalizeSearch("תשפ״ז"), "תשפז");
  assert.equal(normalizeSearch("ראש־בראש"), "ראש בראש");
  assert.equal(normalizeSearch("שָׁלוֹם  עולם"), "שלום עולם");
  const items = [
    { kind: "tab", id: "albums", title: "אלבומים ושירים", sub: "אתר הסקר" },
    { kind: "episode", id: "e1", title: "שירי הסתיו", sub: "תוכנית 12" },
    { kind: "song", id: "a1", title: "הסתיו שלי", sub: "אלבום הזהב" },
    { kind: "album", id: "a1", title: "אלבום הזהב", sub: "אמן" },
    { kind: "artist", id: "r1", title: "יוסי ״הזמר״ כהן" },
  ];
  assert.deepEqual(searchItems(items, "הסתיו").map((item) => item.id), ["a1", "e1"], "a title that starts with the word comes first");
  assert.deepEqual(searchItems(items, "סתיו").map((item) => item.kind), ["episode", "song"], "among partial matches, programmes come before songs");
  assert.deepEqual(searchItems(items, "הסתיו תוכנית 12").map((item) => item.id), ["e1"], "every word must match, the sub line counts");
  assert.deepEqual(searchItems(items, "הזמר").map((item) => item.id), ["r1"]);
  assert.deepEqual(searchItems(items, "").map((item) => item.kind), ["tab"], "an empty query lists the admin sections");
  assert.deepEqual(searchItems(items, "לא קיים"), []);
});
