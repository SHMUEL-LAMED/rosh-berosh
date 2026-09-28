import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_HOSTS, normalizeHosts, publicHosts } from "../worker/program-hosts.js";

/**
 * המגישים של אתר התוכניות (settings.hosts): הכללים (worker/program-hosts.js), ברירת המחדל
 * עד שנשמרה רשימה, והפרסום עם הקטלוג — מול הוורקר הבנוי ו-SQLite אמיתי.
 */

function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async all() {
      const prepared = db.prepare(sql);
      try { return { results: prepared.all(...values), success: true }; }
      catch { return { results: [], success: true, meta: prepared.run(...values) }; }
    },
    async first(column) { const row = db.prepare(sql).get(...values) ?? null; return column && row ? row[column] : row; },
    async run() { return this.all(); },
  });
  return { prepare: (sql) => statement(sql), async batch(statements) { const out = []; for (const item of statements) out.push(await item.all()); return out; } };
}

async function sessionToken(db, email, token = `tok-${email.split("@")[0]}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)").run(hash, `sub-${email}`, email, "משתמש", null, Math.floor(Date.now() / 1000) + 3600);
  return token;
}

async function setup() {
  const url = new URL("../dist/server/index.js", import.meta.url);
  url.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(url.href);
  const db = new DatabaseSync(":memory:");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const media = { async get() { return null; }, async put() {}, async head() { return null; }, async delete() {}, async list() { return { objects: [] }; } };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  const admin = await sessionToken(db, "admin@example.com");
  const call = (path, { method = "GET", body, token } = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", origin: "https://shmuel-lamed.github.io", "cf-connecting-ip": "1.2.3.4", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { call, admin };
}
const episode = { id: "ep-1", slug: "ep-1", title: "תוכנית", date: "2026-09-01", visible: true };
const publish = (call, token, settings) => call("/api/program/catalog", { method: "POST", token, body: { seasons: [], episodes: [episode], settings } });

test("normalizeHosts keeps known fields, drops duplicates and unsafe links", () => {
  assert.equal(normalizeHosts(undefined), null, "not an array: nothing saved yet");
  assert.deepEqual(normalizeHosts([]), [], "an empty list is a choice");
  const [a, ...rest] = normalizeHosts([
    { name: "  קובי   בלום ", role: "מגיש", bio: "שורה\r\nשנייה", photo: "http://x/a.jpg", links: [{ label: "יוטיוב", url: "https://youtube.com/x" }, { url: "javascript:alert(1)" }], seasons: ["slater", "slater", "a b"], current: true, junk: 1 },
    { name: "קובי בלום" }, { name: "" }, { name: "מיכאל לוי", current: false },
  ]);
  assert.deepEqual(a, { name: "קובי בלום", role: "מגיש", bio: "שורה\nשנייה", photo: "", links: [{ label: "יוטיוב", url: "https://youtube.com/x" }], seasons: ["slater", "a-b"], current: true });
  assert.deepEqual(rest.map((h) => [h.name, h.current]), [["מיכאל לוי", false]]);
  assert.deepEqual(publicHosts(undefined).map((h) => h.name), DEFAULT_HOSTS.map((h) => h.name));
});

test("hosts publish with the catalog; until saved the public sees the defaults", async () => {
  const { call, admin } = await setup();
  const catalog = await (await call("/api/program/catalog")).json();
  assert.deepEqual(catalog.episodes.find((e) => e.number === 84).hosts, ["מיכאל לוי", "ירמי סלייטר"], "the one-off substitute replaces the usual host");
  assert.deepEqual(catalog.episodes.find((e) => e.number === 87).guests, ["פיני איינהורן", "גיא מרוז"]);
  assert.ok(catalog.episodes.find((e) => e.number === 88).panelists.includes("ארי וייזר"));
  let pub = catalog.settings;
  assert.deepEqual(pub.hosts.map((h) => h.name), DEFAULT_HOSTS.map((h) => h.name));
  const w = await publish(call, admin, { hosts: [{ name: "ירמי סלייטר", role: "מגיש", seasons: ["slater"], photo: "https://media.example/y.jpg" }, { name: "קובי בלום", bio: "ותיק" }] });
  assert.equal(w.status, 200, await w.clone().text());
  pub = (await (await call("/api/program/catalog")).json()).settings;
  assert.deepEqual(pub.hosts.map((h) => [h.name, h.photo, h.bio]), [["ירמי סלייטר", "https://media.example/y.jpg", ""], ["קובי בלום", "", "ותיק"]], "the saved order is the order on the site");
  await publish(call, admin, {});
  assert.equal((await (await call("/api/program/catalog")).json()).settings.hosts.length, 2, "a publish without hosts keeps them");
  await publish(call, admin, { hosts: [] });
  assert.deepEqual((await (await call("/api/program/catalog")).json()).settings.hosts, [], "an empty list hides the hosts");
});
