import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * הדומיין של אתר התוכניות (שמואלליווי.com) מורשה כמו כתובת GitHub Pages הישנה:
 * קריאה ל־API (CORS) וכתובת חזרה אחרי כניסה (SSO). כתובות אחרות — לא.
 */

function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
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
    async batch(statements) { const out = []; for (const item of statements) out.push(await item.all()); return out; },
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const OLD = "https://shmuel-lamed.github.io";
const NEW = "https://xn--4dbjbascrao3i.com";

async function setup() {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const media = {
    async get() { return null; },
    async put() {},
    async head() { return null; },
    async delete() {},
    async list() { return { objects: [] }; },
  };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  return { worker, env };
}

test("the program site's own domain can read the API, like the GitHub Pages address", async () => {
  const { worker, env } = await setup();
  const ask = (origin) => worker.fetch(new Request("http://localhost/api/program/catalog", { headers: { origin } }), env, ctx);
  assert.equal((await ask(NEW)).headers.get("access-control-allow-origin"), NEW);
  assert.equal((await ask(`https://www.xn--4dbjbascrao3i.com`)).headers.get("access-control-allow-origin"), "https://www.xn--4dbjbascrao3i.com");
  assert.equal((await ask(OLD)).headers.get("access-control-allow-origin"), OLD, "the old address still works");
  assert.equal((await ask("https://evil.example")).headers.get("access-control-allow-origin"), null);
});

test("the program site's own domain is a valid return address after signing in", async () => {
  const { worker, env } = await setup();
  const go = (target) => worker.fetch(new Request(`http://localhost/api/program/sso?return=${encodeURIComponent(target)}`), env, ctx);
  const back = await go(`${NEW}/me.html?x=1`);
  assert.equal(back.status, 302);
  const landing = new URL(back.headers.get("location"));
  assert.equal(landing.origin + landing.pathname, `${NEW}/me.html`);
  assert.equal(landing.searchParams.get("sso"), "none");
  assert.equal((await go(`${OLD}/rosh-berosh-2/me.html`)).status, 302, "the old address still works");
  assert.equal((await go("https://xn--4dbjbascrao3i.com.evil.example/")).status, 400);
  assert.equal((await go(`${OLD}/other/`)).status, 400);
});
