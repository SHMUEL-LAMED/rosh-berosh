import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * פרטי הקשר שנערכים מהניהול, תגובות המאזינים (באישור מנהל) והגהה בבינה
 * מלאכותית — מול הוורקר הבנוי, SQLite אמיתי, R2 ומודל מדומים.
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

function r2() {
  const objects = new Map();
  return {
    async get(key) { const value = objects.get(key); return value ? { async json() { return JSON.parse(value); } } : null; },
    async head() { return null; },
    async put(key, body) { objects.set(key, typeof body === "string" ? body : ""); },
    async delete(key) { objects.delete(key); },
    async list() { return { objects: [] }; },
  };
}

async function sessionToken(db, email, name = "משתמש", token = `tok-${email.split("@")[0]}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, `sub-${email}`, email, name, null, Math.floor(Date.now() / 1000) + 3600);
  return token;
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ORIGIN = "https://shmuel-lamed.github.io";

async function setup() {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const env = { DB: d1(db), MEDIA: r2(), ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  const admin = await sessionToken(db, "admin@example.com");
  const voter = await sessionToken(db, "voter@example.com", "ישראל ישראלי");
  const other = await sessionToken(db, "other@example.com", "שרה כהן");
  const call = (path, { method = "GET", body, token, ip = "1.2.3.4" } = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { db, env, admin, voter, other, call };
}

const episode = (id, extra = {}) => ({ id, slug: id, title: `תוכנית ${id}`, date: "2026-09-01", visible: true, ...extra });
const publish = (call, token, body) => call("/api/program/catalog", { method: "POST", token, body: { seasons: [], episodes: [episode("ep-1")], ...body } });

const DEFAULTS = {
  phone: "077-226-2271",
  phone2: "073-707-9536",
  email: "rbr17011701@gmail.com",
  phoneNote: "האזנה לתוכניות בשלוחה 1, שירים מומלצים בשלוחה 3 והרשמה לצינתוק בשלוחה 4.",
  hostsNote: "לשאלות ולתגובות למגישים: שלוחה 9 בקו התוכן. פורום המאזינים נמצא בשלוחה 5.",
  chatNote: "בבקשה ציינו לאיזו קבוצה להצטרף — גברים או נשים.",
};

/* ---------- פרטי הקשר ---------- */

test("contact details default to the site's current values until they are saved", async () => {
  const { call } = await setup();
  const pub = await (await call("/api/program/catalog")).json();
  assert.deepEqual(pub.settings.contacts, DEFAULTS);
});

test("contact details publish with the catalog, normalized to exactly six fields", async () => {
  const { call, admin } = await setup();
  const write = await publish(call, admin, { settings: { contacts: {
    phone: "  02-1234567  ", phone2: "1".repeat(50), email: "not-an-email", phoneNote: "א".repeat(600), hostsNote: "", chatNote: " הערה ", junk: "x",
  } } });
  assert.equal(write.status, 200, await write.clone().text());
  const { contacts } = (await (await call("/api/program/catalog")).json()).settings;
  assert.deepEqual(Object.keys(contacts).sort(), ["chatNote", "email", "hostsNote", "phone", "phone2", "phoneNote"]);
  assert.equal(contacts.phone, "02-1234567");
  assert.equal(contacts.phone2.length, 30);
  assert.equal(contacts.email, "", "an invalid email is dropped");
  assert.equal(contacts.phoneNote.length, 500);
  assert.equal(contacts.hostsNote, "", "an empty note clears it");
  assert.equal(contacts.chatNote, "הערה");

  await publish(call, admin, { settings: { contacts: { email: ` ${"a".repeat(115)}@x.com ` } } });
  assert.equal((await (await call("/api/program/catalog")).json()).settings.contacts.email, "", "longer than 120 characters");
  await publish(call, admin, { settings: { contacts: { email: "Office@Example.com" } } });
  const saved = (await (await call("/api/program/catalog")).json()).settings.contacts;
  assert.equal(saved.email, "Office@Example.com");
  assert.equal(saved.phone, DEFAULTS.phone, "a field that was not sent keeps its default");

  // a publish without settings leaves them untouched
  await publish(call, admin, {});
  assert.equal((await (await call("/api/program/catalog")).json()).settings.contacts.email, "Office@Example.com");
});

/* ---------- תגובות ---------- */

test("posting a comment needs a session, a public episode and 2–1000 characters", async () => {
  const { db, call, admin, voter } = await setup();
  await publish(call, admin, { episodes: [episode("ep-1"), episode("ep-hidden", { visible: false }), episode("ep-later", { publishAt: "2099-01-01T20:00" })] });
  // every attempt counts toward the per-account limit; the table is cleared so each check is seen
  const post = (body, token = voter) => { db.prepare("DELETE FROM ballot_rate_limits").run(); return call("/api/program/comments", { method: "POST", token, body }); };
  assert.equal((await post({ episodeId: "ep-1", text: "יפה מאוד" }, null)).status, 401);
  assert.equal((await post({ episodeId: "ep-1", text: "א" })).status, 400);
  assert.equal((await post({ episodeId: "ep-1", text: "א".repeat(1001) })).status, 400);
  assert.equal((await post({ episodeId: "ep-1", text: "יפה", at: -3 })).status, 400);
  assert.equal((await post({ episodeId: "ep-1", text: "יפה", at: 1.5 })).status, 400);
  assert.equal((await post({ episodeId: "ep-hidden", text: "יפה מאוד" })).status, 404);
  assert.equal((await post({ episodeId: "ep-later", text: "יפה מאוד" })).status, 404);
  assert.equal((await post({ episodeId: "nope", text: "יפה מאוד" })).status, 404);
});

test("comments are pending until approved; the public sees first names only, pinned first", async () => {
  const { call, admin, voter, other } = await setup();
  await publish(call, admin, {});
  const post = async (body, token) => { const r = await call("/api/program/comments", { method: "POST", token, body }); assert.equal(r.status, 200, await r.clone().text()); return (await r.json()).comment; };
  const first = await post({ episodeId: "ep-1", text: "  השיר בדקה הזאת מדהים  ", at: 125 }, voter);
  assert.deepEqual(Object.keys(first).sort(), ["at", "createdAt", "id", "name", "pinned", "reply", "status", "text"]);
  assert.equal(first.status, "pending");
  assert.equal(first.name, "ישראל");
  assert.equal(first.text, "השיר בדקה הזאת מדהים");
  assert.equal(first.at, 125);
  const second = await post({ episodeId: "ep-1", text: "תוכנית נהדרת" }, other);
  assert.equal(second.at, null);

  // before approval: nothing public; the author sees their own pending comment
  const anon = await (await call("/api/program/comments?episode=ep-1")).json();
  assert.deepEqual(anon, { comments: [], mine: [] });
  const own = await (await call("/api/program/comments?episode=ep-1", { token: voter })).json();
  assert.deepEqual(own.mine.map((c) => c.id), [first.id]);
  assert.equal(own.mine[0].status, "pending");

  // admin list: pending count, emails, newest first; voters are refused
  assert.equal((await call("/api/program/comments/all", { token: voter })).status, 403);
  const all = await (await call("/api/program/comments/all?status=pending", { token: admin })).json();
  assert.equal(all.pending, 2);
  assert.deepEqual(all.comments.map((c) => c.id), [second.id, first.id]);
  assert.equal(all.comments[1].email, "voter@example.com");
  assert.equal(all.comments[1].name, "ישראל ישראלי");
  assert.equal(all.comments[1].episodeId, "ep-1");
  assert.equal(all.comments[1].at, 125);
  assert.equal((await call("/api/program/comments/all?status=bad", { token: admin })).status, 400);

  // approve both, pin the second, reply to the first
  const moderate = (body, token = admin) => call("/api/program/comments/moderate", { method: "POST", token, body });
  assert.equal((await moderate({ id: first.id, status: "approved" }, voter)).status, 403);
  assert.equal((await moderate({ id: first.id, status: "weird" })).status, 400);
  assert.equal((await moderate({ id: "missing", status: "approved" })).status, 404);
  const replied = await (await moderate({ id: first.id, status: "approved", reply: "תודה רבה!" })).json();
  assert.equal(replied.ok, true);
  assert.equal(replied.comment.status, "approved");
  assert.equal(replied.comment.reply, "תודה רבה!");
  assert.equal(replied.comment.replyBy, "admin@example.com");
  assert.equal((await moderate({ id: second.id, status: "approved", pinned: true })).status, 200);

  const pub = await (await call("/api/program/comments?episode=ep-1")).json();
  assert.deepEqual(pub.comments.map((c) => c.id), [second.id, first.id], "pinned first, then oldest first");
  assert.equal(pub.comments[0].pinned, true);
  assert.equal(pub.comments[0].name, "שרה");
  assert.equal(pub.comments[1].reply, "תודה רבה!");
  assert.doesNotMatch(JSON.stringify(pub), /@example\.com|sub-|replyBy|status/, "no emails, account ids or moderation details");
  assert.deepEqual((await (await call("/api/program/comments?episode=ep-1", { token: voter })).json()).mine, [], "approved ones leave `mine`");

  // clearing the reply, hiding, deleting
  const cleared = await (await moderate({ id: first.id, reply: "" })).json();
  assert.equal(cleared.comment.reply, null);
  assert.equal(cleared.comment.replyBy, null);
  await moderate({ id: second.id, status: "hidden" });
  assert.deepEqual((await (await call("/api/program/comments?episode=ep-1")).json()).comments.map((c) => c.id), [first.id]);
  const hidden = await (await call("/api/program/comments/all?status=hidden", { token: admin })).json();
  assert.deepEqual(hidden.comments.map((c) => c.id), [second.id]);
  assert.equal(hidden.pending, 0);
  assert.equal((await call("/api/program/comments", { method: "DELETE", token: voter, body: { id: first.id } })).status, 403);
  assert.equal((await call("/api/program/comments", { method: "DELETE", token: admin, body: { id: first.id } })).status, 200);
  const everything = await (await call("/api/program/comments/all", { token: admin })).json();
  assert.deepEqual(everything.comments.map((c) => c.id), [second.id]);
});

test("comments are rate-limited per account", async () => {
  const { call, admin, voter } = await setup();
  await publish(call, admin, {});
  const statuses = [];
  for (let n = 0; n < 7; n += 1) statuses.push((await call("/api/program/comments", { method: "POST", token: voter, ip: `9.9.9.${n}`, body: { episodeId: "ep-1", text: `תגובה ${n}` } })).status);
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses.at(-1), 429);
});

/* ---------- הגהה ---------- */

test("proofreading returns only changed items with word-level changes", async () => {
  const { call, env, admin, voter } = await setup();
  const items = [
    { key: "ep-1.title", text: "התוכנית החדש של ראש בראש" },
    { key: "ep-1.description", text: "בע''ה נשמע שירים יפים,ונדבר עם האורחים 🎵" },
    { key: "ep-2.title", text: "ללא שינוי" },
  ];
  const sent = [];
  env.AI = {
    async run(model, input) {
      sent.push({ model, input });
      return { response: "```json\n" + JSON.stringify({ results: [
        { key: "ep-1.title", fixed: "התוכנית החדשה של ראש בראש" },
        { key: "ep-1.description", fixed: "בע״ה נשמע שירים יפים, ונדבר עם האורחים 🎵" },
        { key: "ep-2.title", fixed: "ללא שינוי" },
        { key: "unknown", fixed: "לא ביקשו" },
      ] }) + "\n```" };
    },
  };
  assert.equal((await call("/api/program/ai/proofread", { method: "POST", token: voter, body: { items } })).status, 403);
  const response = await call("/api/program/ai/proofread", { method: "POST", token: admin, body: { items } });
  assert.equal(response.status, 200, await response.clone().text());
  const { results } = await response.json();
  assert.deepEqual(results, [
    { key: "ep-1.title", fixed: "התוכנית החדשה של ראש בראש", changes: [{ from: "החדש", to: "החדשה" }] },
    { key: "ep-1.description", fixed: "בע״ה נשמע שירים יפים, ונדבר עם האורחים 🎵", changes: [{ from: "בע''ה", to: "בע״ה" }, { from: "יפים,ונדבר", to: "יפים, ונדבר" }] },
  ]);
  assert.equal(sent[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.match(sent[0].input.messages[0].content, /"results"/);
  assert.match(sent[0].input.messages[1].content, /ep-1\.description/);
});

test("proofreading validates its input and reports unreadable model output", async () => {
  const { call, env, admin } = await setup();
  const proofread = (body) => call("/api/program/ai/proofread", { method: "POST", token: admin, body });
  env.AI = { run: async () => ({ response: "סליחה, אני לא יכול" }) };
  assert.equal((await proofread({ items: [] })).status, 400);
  assert.equal((await proofread({})).status, 400);
  assert.equal((await proofread({ items: Array.from({ length: 41 }, (_, n) => ({ key: `k${n}`, text: "א" })) })).status, 400);
  assert.equal((await proofread({ items: [{ key: "a", text: "א".repeat(20_001) }, { key: "b", text: "ב".repeat(20_000) }] })).status, 400);
  assert.equal((await proofread({ items: [{ key: "a", text: 5 }] })).status, 400);
  const bad = await proofread({ items: [{ key: "a", text: "שלום" }] });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /אי אפשר לקרוא/);
  env.AI = { run: async () => ({ response: '{"results": []}' }) };
  assert.deepEqual(await (await proofread({ items: [{ key: "a", text: "שלום" }] })).json(), { results: [] });
});

test("proofreading goes to Claude when the key is set", async () => {
  const { call, env, admin } = await setup();
  env.ANTHROPIC_API_KEY = "sk-test";
  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== "https://api.anthropic.com/v1/messages") return original(input, init);
    sent = JSON.parse(init.body);
    return Response.json({ content: [{ type: "text", text: '{"results":[{"key":"a","fixed":"שלום עולם, מה נשמע"}]}' }], stop_reason: "end_turn" });
  };
  try {
    const response = await call("/api/program/ai/proofread", { method: "POST", token: admin, body: { items: [{ key: "a", text: "שלום עולם,מה נשמע" }] } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).results, [{ key: "a", fixed: "שלום עולם, מה נשמע", changes: [{ from: "עולם,מה", to: "עולם, מה" }] }]);
    assert.match(sent.system, /גרשיים/);
    assert.match(sent.messages[0].content, /שלום עולם,מה נשמע/);
  } finally { globalThis.fetch = original; }
});

test("word changes stay aligned around insertions and are capped at 30", async () => {
  const { call, env, admin } = await setup();
  const long = Array.from({ length: 80 }, (_, n) => `מילה${n}`).join(" ");
  const fixedLong = Array.from({ length: 80 }, (_, n) => (n % 2 ? `תיקון${n}` : `מילה${n}`)).join(" ");
  env.AI = { run: async () => ({ response: JSON.stringify({ results: [
    { key: "insert", fixed: "אחת שתיים וגם שלוש ארבע" },
    { key: "long", fixed: fixedLong },
  ] }) }) };
  const { results } = await (await call("/api/program/ai/proofread", { method: "POST", token: admin, body: { items: [{ key: "insert", text: "אחת שתיים שלוש ארבע" }, { key: "long", text: long }] } })).json();
  assert.deepEqual(results[0].changes, [{ from: "", to: "וגם" }]);
  assert.equal(results[1].changes.length, 30);
  assert.deepEqual(results[1].changes[0], { from: "מילה1", to: "תיקון1" });
});

/* ---------- "הרגעים הכי חמים" ---------- */

test("listeners mark moments privately, rounded down to 5 seconds", async () => {
  const { call, admin, voter, other } = await setup();
  await publish(call, admin, { episodes: [episode("ep-1"), episode("ep-hidden", { visible: false }), episode("ep-soon", { publishAt: "2099-01-01T20:00" })] });
  const mark = (token, body) => call("/api/program/moments", { method: "POST", token, body });

  assert.equal((await mark(null, { episodeId: "ep-1", at: 10, on: true })).status, 401);
  assert.equal((await call("/api/program/moments/mine?episode=ep-1")).status, 401);
  assert.equal((await mark(voter, { episodeId: "ep-hidden", at: 10, on: true })).status, 404);
  assert.equal((await mark(voter, { episodeId: "ep-soon", at: 10, on: true })).status, 404);
  assert.equal((await mark(voter, { episodeId: "nope", at: 10, on: true })).status, 404);
  assert.equal((await mark(voter, { episodeId: "ep-1", at: -1, on: true })).status, 400);
  assert.equal((await mark(voter, { episodeId: "ep-1", at: "abc", on: true })).status, 400);
  assert.equal((await mark(voter, { episodeId: "ep-1", at: 5, on: "yes" })).status, 400);

  const first = await mark(voter, { episodeId: "ep-1", at: 64.9, on: true });
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json(), { ok: true, at: 60, on: true });
  await mark(voter, { episodeId: "ep-1", at: 62, on: true }); // אותו רגע — לא נכפל
  await mark(voter, { episodeId: "ep-1", at: 7, on: true });
  await mark(other, { episodeId: "ep-1", at: 120, on: true });
  assert.deepEqual(await (await call("/api/program/moments/mine?episode=ep-1", { token: voter })).json(), { moments: [5, 60] });
  assert.deepEqual(await (await call("/api/program/moments/mine?episode=ep-1", { token: other })).json(), { moments: [120] });

  assert.deepEqual(await (await mark(voter, { episodeId: "ep-1", at: 9, on: false })).json(), { ok: true, at: 5, on: false });
  assert.deepEqual(await (await call("/api/program/moments/mine?episode=ep-1", { token: voter })).json(), { moments: [60] });
});

test("moment heat is for admins only, in 30-second buckets of distinct listeners", async () => {
  const { call, db, admin, voter, other } = await setup();
  await publish(call, admin, { episodes: [episode("ep-1"), episode("ep-2")] });
  const mark = (token, episodeId, at) => call("/api/program/moments", { method: "POST", token, body: { episodeId, at, on: true } });
  await mark(voter, "ep-1", 30); await mark(voter, "ep-1", 45); await mark(voter, "ep-1", 300);
  await mark(other, "ep-1", 50); await mark(other, "ep-1", 0);
  await mark(admin, "ep-1", 59);
  await mark(voter, "ep-2", 10);

  assert.equal((await call("/api/program/moments/ep-1", { token: voter })).status, 403);
  assert.equal((await call("/api/program/moments/ep-1")).status, 403);
  const heat = await (await call("/api/program/moments/ep-1", { token: admin })).json();
  assert.deepEqual(heat, {
    id: "ep-1", total: 3,
    buckets: [{ at: 0, count: 1 }, { at: 30, count: 3 }, { at: 300, count: 1 }],
    top: [{ at: 30, count: 3 }, { at: 0, count: 1 }, { at: 300, count: 1 }],
  });
  assert.deepEqual(await (await call("/api/program/moments/ep-9", { token: admin })).json(), { id: "ep-9", total: 0, buckets: [], top: [] });

  // marks older than 90 days are left out of the stats ranking
  db.prepare("INSERT INTO program_moments (user_sub,episode_id,at_seconds,created_at) VALUES ('old','ep-2',5,?),('old','ep-2',10,?),('old','ep-2',15,?),('old','ep-2',20,?),('old','ep-2',25,?),('old','ep-2',35,?)")
    .run(...Array(6).fill(Math.floor(Date.now() / 1000) - 91 * 86400));
  const stats = await (await call("/api/program/stats", { token: admin })).json();
  assert.deepEqual(stats.moments, [{ id: "ep-1", count: 6 }, { id: "ep-2", count: 1 }]);
});

test("moments are capped at 200 per listener per episode and rate limited", async () => {
  const { call, db, admin, voter } = await setup();
  await publish(call, admin, { episodes: [episode("ep-1")] });
  const insert = db.prepare("INSERT INTO program_moments (user_sub,episode_id,at_seconds) VALUES (?,?,?)");
  for (let n = 0; n < 200; n += 1) insert.run("sub-voter@example.com", "ep-1", n * 5);
  const mark = (at, on = true) => call("/api/program/moments", { method: "POST", token: voter, body: { episodeId: "ep-1", at, on } });
  const over = await mark(5000);
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /200/);
  assert.equal((await mark(10)).status, 200, "an existing mark can be set again");
  assert.equal((await mark(10, false)).status, 200);
  assert.equal((await mark(5000)).status, 200, "room again after removing one");

  const statuses = [];
  for (let n = 0; n < 30; n += 1) statuses.push((await mark(0, false)).status);
  assert.ok(statuses.includes(429), "30 a minute, then 429");
  assert.equal(statuses.filter((status) => status === 200).length, 26);
});

/* ---------- הצעות לשם מהתמלול ---------- */

test("title suggestions need a finished transcript and come back trimmed and deduped", async () => {
  const { call, db, env, admin, voter } = await setup();
  await publish(call, admin, { episodes: [episode("ep-1")] });
  const sent = [];
  env.AI = { async run(model, input) {
    sent.push({ model, input });
    return { response: "הנה ההצעות:\n```json\n" + JSON.stringify({
      titles: ["  1. ניגון של שבת  ", "\"קולות מהעיר\"", "ניגון של שבת", "", 7, "הפתעה   באולפן", "שיר חדש ושמח", "ראש בראש עם האורח", "עודף"],
      whatsapp: "  🎵 תוכנית חדשה עלתה!\nהאזינו עכשיו  ",
    }) + "\n```" };
  } };
  const titles = (token = admin, body = { episodeId: "ep-1" }) => call("/api/program/ai/titles", { method: "POST", token, body });
  assert.equal((await titles(voter)).status, 403);
  const early = await titles();
  assert.equal(early.status, 409);
  assert.match((await early.json()).error, /תמלול/);
  db.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total) VALUES ('ep-1','דיברנו על ניגוני שבת',1,2)").run();
  assert.equal((await titles()).status, 409, "a partial transcript is not enough");
  db.prepare("UPDATE program_transcripts SET parts_done=2").run();

  const response = await titles();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    titles: ["ניגון של שבת", "קולות מהעיר", "הפתעה באולפן", "שיר חדש ושמח", "ראש בראש עם האורח"],
    whatsapp: "🎵 תוכנית חדשה עלתה!\nהאזינו עכשיו",
  });
  assert.equal(sent[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.match(sent[0].input.messages[0].content, /whatsapp/);
  assert.match(sent[0].input.messages[0].content, /ראש בראש/);
  assert.match(sent[0].input.messages[1].content, /ניגוני שבת/);

  env.AI = { run: async () => ({ response: "אין לי רעיונות" }) };
  const unreadable = await titles();
  assert.equal(unreadable.status, 502);
  assert.match((await unreadable.json()).error, /אי אפשר לקרוא/);
  env.AI = { run: async () => { throw new Error("down"); } };
  assert.equal((await titles()).status, 502);
});

test("title suggestions go to Claude when the key is set", async () => {
  const { call, db, env, admin } = await setup();
  db.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total) VALUES ('ep-1','תמלול קצר',1,1)").run();
  env.ANTHROPIC_API_KEY = "sk-test";
  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== "https://api.anthropic.com/v1/messages") return original(input, init);
    sent = JSON.parse(init.body);
    return Response.json({ content: [{ type: "text", text: '{"titles":["שם אחד","שם שני"],"whatsapp":"האזינו 🎧"}' }], stop_reason: "end_turn" });
  };
  try {
    const response = await call("/api/program/ai/titles", { method: "POST", token: admin, body: { episodeId: "ep-1" } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { titles: ["שם אחד", "שם שני"], whatsapp: "האזינו 🎧" });
    assert.match(sent.system, /"titles"/);
    assert.match(sent.messages[0].content, /תמלול קצר/);
  } finally { globalThis.fetch = original; }
});
