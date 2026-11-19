import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * כלי בינה מלאכותית שמנהל את אתר התוכניות: מי שמציג את הסוד `AI_ADMIN_KEY` מקבל
 * הרשאת מנהל בנתיבים של אתר התוכניות בלבד. הבדיקות רצות על הוורקר הבנוי מול SQLite אמיתי.
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
    async batch(statements) { return Promise.all(statements.map((item) => item.all())); },
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const KEY = "k".repeat(40);

async function setup(extra = {}) {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const media = { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [] }; } };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) }, ...extra };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  return { worker, env };
}

const get = (worker, env, path, token) => worker.fetch(new Request(`http://localhost${path}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}), env, ctx);

test("the AI key signs in as an administrator of the program site", async () => {
  const { worker, env } = await setup({ AI_ADMIN_KEY: KEY });
  const me = await get(worker, env, "/api/program/me", KEY);
  assert.equal(me.status, 200, await me.clone().text());
  const { user } = await me.json();
  assert.equal(user.isAdmin, true);
  assert.equal(user.name, "כלי בינה מלאכותית");

  const catalog = await get(worker, env, "/api/program/catalog", KEY);
  assert.equal(catalog.status, 200);
  assert.ok("versionId" in (await catalog.json()), "administrators get the version id used for publishing");
});

test("a wrong key, or no key, is not signed in", async () => {
  const { worker, env } = await setup({ AI_ADMIN_KEY: KEY });
  assert.equal((await get(worker, env, "/api/program/me", "x".repeat(40))).status, 401);
  assert.equal((await get(worker, env, "/api/program/me", KEY.slice(0, 39))).status, 401);
  assert.equal((await get(worker, env, "/api/program/me")).status, 401);
  const catalog = await get(worker, env, "/api/program/catalog", "x".repeat(40));
  assert.ok(!("versionId" in (await catalog.json())), "the public catalog carries no version id");
});

test("the entrance is closed when the secret is missing or too short", async () => {
  for (const extra of [{}, { AI_ADMIN_KEY: "" }, { AI_ADMIN_KEY: "short-key" }]) {
    const { worker, env } = await setup(extra);
    assert.equal((await get(worker, env, "/api/program/me", extra.AI_ADMIN_KEY || KEY)).status, 401);
  }
});

test("the AI key does not open the voting site's administration", async () => {
  const { worker, env } = await setup({ AI_ADMIN_KEY: KEY });
  const response = await get(worker, env, "/api/admin/overview", KEY);
  assert.ok([401, 403].includes(response.status), `status ${response.status}`);
});

test("the AI key opens neither the administrators list nor a way into the voting site", async () => {
  const { worker, env } = await setup({ AI_ADMIN_KEY: KEY });
  const send = (path, method, body) => worker.fetch(new Request(`http://localhost${path}`, {
    method,
    redirect: "manual",
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  const denied = async (path, method, body) => {
    const response = await send(path, method, body);
    assert.ok([401, 403].includes(response.status), `${method} ${path}: status ${response.status}`);
  };
  await denied("/api/program/admins", "GET");
  await denied("/api/program/admins", "POST", { email: "intruder@example.com" });
  await denied("/api/program/admins", "DELETE", { email: "admin@example.com" });
  await denied("/api/program/handoff", "POST");

  // ניווטים של דף שלם: בלי חיבור הם מפנים הלאה בלי קוד מעבר
  const toPrograms = await send("/api/program/handoff/to-programs", "GET");
  assert.equal(toPrograms.status, 302);
  assert.ok(!String(toPrograms.headers.get("location")).includes("handoff="), toPrograms.headers.get("location"));
  const sso = await send(`/api/program/sso?return=${encodeURIComponent("https://shmuel-lamed.github.io/rosh-berosh-2/")}`, "GET");
  assert.equal(sso.status, 302);
  assert.equal(new URL(sso.headers.get("location")).searchParams.get("sso"), "none");

  const me = await get(worker, env, "/api/program/me", KEY);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.isAdmin, true);
});
