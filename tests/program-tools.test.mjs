import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * כלי הניהול של אתר התוכניות: הגדרות שמתפרסמות עם הקטלוג (הודעה בדף הבית,
 * דף עדכונים) וגרסה שנשמרת בכל פרסום, טיוטה משותפת, קישור תצוגה מקדימה,
 * אירועי האזנה וסטטיסטיקה, הודעות מהמאזינים, רשימת המנהלים ורשימת התפוצה —
 * כולם מול הוורקר הבנוי ו-SQLite אמיתי.
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

async function sessionToken(db, email, token = `tok-${email.split("@")[0]}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, `sub-${email}`, email, "משתמש", null, Math.floor(Date.now() / 1000) + 3600);
  return token;
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const ORIGIN = "https://shmuel-lamed.github.io";

async function setup() {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const saved = [];
  const media = {
    async get(key) { return key === "settings/admin-emails.json" ? { async json() { return saved; } } : null; },
    async put(key, body) { if (key === "settings/admin-emails.json") { saved.length = 0; saved.push(...JSON.parse(body)); } },
    async head() { return null; },
    async delete() {},
    async list() { return { objects: [] }; },
  };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  const admin = await sessionToken(db, "admin@example.com");
  const voter = await sessionToken(db, "voter@example.com");
  const call = (path, { method = "GET", body, token, ip = "1.2.3.4" } = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { worker, db, env, admin, voter, call, saved };
}

const publish = (call, token, extra = {}) => call("/api/program/catalog", { method: "POST", token, body: { seasons: [{ id: "s1", title: "עונה" }], episodes: [{ id: "ep-1", slug: "ep-1", title: "תוכנית", date: "2026-09-01", visible: true }], ...extra } });

test("the home banner and the updates page publish with the catalog and reach the public catalog", async () => {
  const { call, admin } = await setup();
  const write = await publish(call, admin, { settings: { banner: { enabled: true, text: "התוכנית הבאה ביום חמישי", link: "updates.html", until: "2030-01-01", junk: "x" }, updates: [{ title: "עדכון", text: "תוכן", date: "2026-09-20" }, { title: "", text: "" }] } });
  assert.equal(write.status, 200, await write.clone().text());
  const pub = await (await call("/api/program/catalog")).json();
  assert.equal(pub.settings.banner.text, "התוכנית הבאה ביום חמישי");
  assert.equal(pub.settings.banner.enabled, true);
  assert.equal("junk" in pub.settings.banner, false, "unknown banner fields are dropped");
  assert.equal(pub.settings.updates.length, 1, "empty updates are dropped");
  assert.ok(pub.settings.updates[0].id, "every update gets an id");
  assert.ok(pub.episodes.some((e) => e.id === "ep-1"), "the seeded catalog gained the published program");

  // a publish without settings leaves them untouched
  await publish(call, admin);
  const again = await (await call("/api/program/catalog")).json();
  assert.equal(again.settings.banner.text, "התוכנית הבאה ביום חמישי");
});

test("every publish is kept as a version an administrator can read back", async () => {
  const { call, admin, voter } = await setup();
  await publish(call, admin);
  await publish(call, admin, { episodes: [{ id: "ep-1", slug: "ep-1", title: "תוכנית מעודכנת", visible: true }] });
  const list = await (await call("/api/program/versions", { token: admin })).json();
  assert.equal(list.versions.length, 2);
  assert.equal(list.versions[0].by, "admin@example.com");
  const one = await (await call(`/api/program/versions/${list.versions[1].id}`, { token: admin })).json();
  assert.equal(one.data.episodes[0].title, "תוכנית");
  assert.equal((await call("/api/program/versions", { token: voter })).status, 403);
  assert.equal((await call("/api/program/versions")).status, 403);
});

test("the shared draft is saved per administrator session and cleared by a publish", async () => {
  const { call, admin, voter } = await setup();
  assert.equal((await call("/api/program/draft", { token: voter })).status, 403);
  const put = await call("/api/program/draft", { method: "PUT", token: admin, body: { data: { seasons: [], episodes: [{ id: "ep-9", title: "טיוטה" }] } } });
  assert.equal(put.status, 200, await put.clone().text());
  const got = await (await call("/api/program/draft", { token: admin })).json();
  assert.equal(got.draft.data.episodes[0].title, "טיוטה");
  assert.equal(got.draft.by, "admin@example.com");
  assert.equal((await call("/api/program/draft", { method: "PUT", token: admin, body: { data: { episodes: "no" } } })).status, 400);
  await publish(call, admin);
  assert.equal((await (await call("/api/program/draft", { token: admin })).json()).draft, null, "publishing folds the draft in");
});

test("a preview link shows the draft to anyone who has it, until it is revoked", async () => {
  const { call, admin } = await setup();
  await call("/api/program/draft", { method: "PUT", token: admin, body: { data: { seasons: [], episodes: [{ id: "ep-9", title: "טיוטה לתצוגה" }] } } });
  const { preview } = await (await call("/api/program/preview", { method: "POST", token: admin })).json();
  assert.match(preview.token, /^[a-f0-9]{32}$/);
  const open = await call(`/api/program/preview/${preview.token}`);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal((await open.json()).data.episodes[0].title, "טיוטה לתצוגה");
  assert.equal((await call("/api/program/preview/wrong")).status, 404);
  await call("/api/program/preview", { method: "DELETE", token: admin });
  assert.equal((await call(`/api/program/preview/${preview.token}`)).status, 404);
});

test("listening events are anonymous, rate limited, and add up to administrator statistics", async () => {
  const { call, admin, voter } = await setup();
  for (const [ip, kind, seconds] of [["1.1.1.1", "play", 0], ["1.1.1.1", "listen", 120], ["2.2.2.2", "play", 0], ["2.2.2.2", "play", 0]]) {
    const r = await call("/api/program/events", { method: "POST", ip, body: { kind, episodeId: "ep-1", seconds, device: "phone" } });
    assert.equal(r.status, 200, await r.clone().text());
  }
  assert.equal((await call("/api/program/events", { method: "POST", body: { kind: "play" } })).status, 400);
  for (let i = 0; i < 5; i++) await call("/api/program/events", { method: "POST", ip: "9.9.9.9", body: { kind: "play", episodeId: "ep-1" } });
  assert.equal((await call("/api/program/events", { method: "POST", ip: "9.9.9.9", body: { kind: "play", episodeId: "ep-1" } })).status, 429);
  assert.equal((await call("/api/program/stats", { token: voter })).status, 403);
  const stats = await (await call("/api/program/stats", { token: admin })).json();
  assert.equal(Number(stats.totals.plays), 3 + 5);
  assert.equal(stats.episodes[0].id, "ep-1");
  assert.equal(Number(stats.episodes[0].seconds), 120);
  assert.equal(stats.days.length, 1);
  assert.equal(Number(stats.devices.phone), 3, "only plays count, and only those that named a phone");
  assert.ok(Number(stats.totals.listeners) >= 2);
});

test("listeners write to the hosts; administrators read, mark and delete", async () => {
  const { call, admin, voter } = await setup();
  const anon = await call("/api/program/messages", { method: "POST", body: { name: "דוד", email: "d@example.com", text: "תוכנית מצוינת!", episodeId: "ep-1" } });
  assert.equal(anon.status, 200, await anon.clone().text());
  const signed = await call("/api/program/messages", { method: "POST", token: voter, ip: "5.5.5.5", body: { name: "מתחזה", email: "fake@example.com", text: "שלום" } });
  assert.equal(signed.status, 200);
  assert.equal((await call("/api/program/messages", { method: "POST", body: { text: "" } })).status, 400);
  assert.equal((await call("/api/program/messages", { token: voter })).status, 403);
  const inbox = await (await call("/api/program/messages", { token: admin })).json();
  assert.equal(inbox.unread, 2);
  const mine = inbox.messages.find((m) => m.text === "שלום");
  assert.equal(mine.email, "voter@example.com", "a signed-in listener's address comes from the session, not the body");
  const { id } = inbox.messages.find((m) => m.text === "תוכנית מצוינת!");
  await call("/api/program/messages/read", { method: "POST", token: admin, body: { id } });
  assert.equal((await (await call("/api/program/messages", { token: admin })).json()).unread, 1);
  await call("/api/program/messages", { method: "DELETE", token: admin, body: { id } });
  assert.equal((await (await call("/api/program/messages", { token: admin })).json()).messages.length, 1);
});

test("the program site manages the same administrator list as the voting site", async () => {
  const { call, admin, voter, saved } = await setup();
  assert.equal((await call("/api/program/admins", { token: voter })).status, 403);
  const list = await (await call("/api/program/admins", { token: admin })).json();
  assert.equal(list.admins.length, 1);
  assert.equal(list.admins[0].email, "admin@example.com");
  assert.equal(list.admins[0].fixed, true);
  assert.equal(list.admins[0].you, true);
  assert.ok(Number(list.admins[0].lastSeen) > 0, "the last sign-in comes from the shared sessions table");
  const add = await call("/api/program/admins", { method: "POST", token: admin, body: { email: "Editor@Example.com" } });
  assert.equal(add.status, 200, await add.clone().text());
  assert.deepEqual(saved, ["admin@example.com", "editor@example.com"], "the list is stored where the voting site reads it");
  assert.equal((await call("/api/program/admins", { method: "DELETE", token: admin, body: { email: "admin@example.com" } })).status, 400, "you cannot remove yourself");
  const remove = await call("/api/program/admins", { method: "DELETE", token: admin, body: { email: "editor@example.com" } });
  assert.equal((await remove.json()).admins.length, 1);
  assert.equal((await call("/api/program/admins", { method: "POST", token: admin, body: { email: "nope" } })).status, 400);
});

test("one-click mailing-list signup uses the signed-in account and the voting site's table", async () => {
  const { call, admin, voter, db } = await setup();
  assert.equal((await call("/api/program/subscribe")).status, 401);
  assert.equal((await (await call("/api/program/subscribe", { token: voter })).json()).subscribed, false);
  const join = await call("/api/program/subscribe", { method: "POST", token: voter });
  assert.equal(join.status, 200, await join.clone().text());
  assert.equal(join.headers.get("access-control-allow-origin"), ORIGIN);
  const row = db.prepare("SELECT email, source, unsubscribed_at AS gone FROM subscribers").get();
  assert.equal(row.email, "voter@example.com");
  assert.equal(row.source, "program");
  assert.equal((await (await call("/api/program/subscribe", { token: voter })).json()).subscribed, true);
  const count = await (await call("/api/program/subscribers/count", { token: admin })).json();
  assert.equal(count.active, 1);
  assert.equal(count.fromProgram, 1);
  await call("/api/program/subscribe", { method: "DELETE", token: voter });
  assert.equal((await (await call("/api/program/subscribe", { token: voter })).json()).subscribed, false);
  assert.equal((await call("/api/program/subscribers/count", { token: voter })).status, 403);
});
