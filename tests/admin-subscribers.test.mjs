import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * רשימת התפוצה בניהול: „חדשים” ו„טופלו” (/api/admin/subscribers/handled), מול הוורקר הבנוי ו־SQLite.
 * מסמנים את החדשים כטופלו אחרי שהעבירו אותם לרשימה אחרת — ומי שמצטרף אחר כך שוב „חדש”.
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
  const call = async (path, { method = "GET", body, who = cookie } = {}) => worker.fetch(new Request(`http://localhost${path}`, { method, headers: { ...(who ? { cookie: who } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { worker, db, env, cookie, call };
}


test("new subscribers can be marked as handled, all at once or one by one, and newcomers stay new", async () => {
  const { db, call } = await setup();
  const list = async () => (await call("/api/admin/subscribers")).json();
  assert.equal((await call("/api/admin/subscribers/handled", { method: "POST", body: { all: true }, who: null })).status, 403, "administrators only");

  await call("/api/admin/subscribers/import", { method: "POST", body: { content: "a@example.com\nb@example.com\nc@example.com" } });
  let data = await list();
  assert.equal(data.fresh, 3, "everyone starts as new");
  assert.ok(data.subscribers.every((row) => row.handledAt === null));

  // הרשימה נטענה; מישהו הצטרף אחר כך — הסימון של „כל החדשים” לא כולל אותו
  const loadedAt = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO subscribers (id,email,source,created_at) VALUES ('late','late@example.com','site',?)").run(loadedAt + 60);
  const all = await (await call("/api/admin/subscribers/handled", { method: "POST", body: { all: true, before: loadedAt } })).json();
  assert.equal(all.changed, 3);
  data = await list();
  assert.equal(data.fresh, 1);
  assert.deepEqual(data.subscribers.filter((row) => !row.handledAt).map((row) => row.email), ["late@example.com"], "who joined later is still new");

  // אחד חוזר ל„חדשים”, ואחר כך מסומן שוב
  await call("/api/admin/subscribers/handled", { method: "POST", body: { emails: ["B@Example.com "], handled: false } });
  data = await list();
  assert.deepEqual(data.subscribers.filter((row) => !row.handledAt).map((row) => row.email).sort(), ["b@example.com", "late@example.com"]);
  const one = await (await call("/api/admin/subscribers/handled", { method: "POST", body: { emails: ["late@example.com", "b@example.com"] } })).json();
  assert.equal(one.changed, 2);
  assert.equal((await list()).fresh, 0);

  // מי שמצטרף עכשיו — חדש; כתובת קיימת שמיובאת שוב נשארת „טופלה”
  await call("/api/admin/subscribers/import", { method: "POST", body: { content: "a@example.com\nd@example.com" } });
  data = await list();
  assert.deepEqual(data.subscribers.filter((row) => !row.handledAt).map((row) => row.email), ["d@example.com"]);
  assert.equal((await call("/api/admin/subscribers/handled", { method: "POST", body: { emails: [] } })).status, 400);
});
