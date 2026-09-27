import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyGuestSuggestions, collectGuests, guestKey, guestSuggestions, normalizeGuests, removeGuest, renameGuest } from "../worker/program-guests.js";

/**
 * האורחים של אתר התוכניות: הכללים המשותפים (worker/program-guests.js), הפרופילים
 * שמתפרסמים עם הקטלוג (settings.guests), והשלמת האורחים מהסיכומים של התמלולים
 * (GET /api/program/ai/guests) — מול הוורקר הבנוי ו-SQLite אמיתי.
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

const publish = (call, token, extra = {}) => call("/api/program/catalog", { method: "POST", token, body: { seasons: [{ id: "s1", title: "קובי בלום וירמי סלייטר" }], episodes: [{ id: "ep-1", slug: "ep-1", title: "תוכנית", date: "2026-09-01", visible: true, guests: ["יואלי קליין"] }], ...extra } });

test("the same guest is recognised across spacing, niqqud and case", () => {
  assert.equal(guestKey("יוֹאֵלִי   קליין "), guestKey("יואלי קליין"));
  assert.equal(guestKey("Avraham Fried"), guestKey("avraham  fried"));
  assert.equal(guestKey(""), "");
});

test("profiles keep only safe fields, drop duplicates and empty profiles", () => {
  const out = normalizeGuests([
    { name: " יואלי  קליין ", role: "זמר", bio: "שורה\r\nשנייה", photo: "http://insecure/x.jpg", links: [{ label: "יוטיוב", url: "https://youtube.com/x" }, { label: "רע", url: "javascript:alert(1)" }], junk: 1 },
    { name: "יואלי קליין", role: "כפול" },
    { name: "רק שם" },
    { name: "", role: "בלי שם" },
    "not an object",
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { name: "יואלי קליין", role: "זמר", bio: "שורה\nשנייה", photo: "", links: [{ label: "יוטיוב", url: "https://youtube.com/x" }] });
});

test("renaming merges spellings and never duplicates a guest inside an episode", () => {
  const eps = [{ id: "a", guests: ["יואלי  קליין", "מוטי"] }, { id: "b", guests: ["יואלי קליין"] }, { id: "c", guests: ["אחר"] }];
  const merged = renameGuest(eps, "יואלי קליין", "מוטי");
  assert.deepEqual(merged.map((e) => e.guests), [["מוטי"], ["מוטי"], ["אחר"]]);
  assert.equal(merged[2], eps[2], "untouched episodes keep their identity");
  assert.deepEqual(removeGuest(eps, "יואלי קליין").map((e) => e.guests), [["מוטי"], [], ["אחר"]]);
  const guests = collectGuests(eps, [{ name: "בלי תוכניות", role: "x", bio: "", photo: "", links: [] }]);
  assert.equal(guests[0].name, "יואלי  קליין".replace(/\s+/g, " "));
  assert.equal(guests[0].count, 2);
  assert.ok(guests.find((g) => g.name === "בלי תוכניות" && g.count === 0), "a profile without episodes stays listed");
});

test("suggestions skip names already present, reuse known spellings and doubt hosts", () => {
  const seasons = [{ id: "s1", title: "קובי בלום וירמי סלייטר" }];
  const eps = [
    { id: "e1", title: "אחת", season: "s1", guests: ["יואלי קליין"] },
    { id: "e2", title: "שתיים", season: "s1", guests: [] },
    { id: "e3", title: "שלוש", season: "", guests: [] },
  ];
  const out = guestSuggestions(eps, [
    { episodeId: "e1", guests: ["יואלי קליין", "קובי בלום"] },
    { episodeId: "e2", guests: ["יואלי   קליין", "מוטי שטיינמץ"] },
    { episodeId: "e3", guests: ["מוטי שטיינמץ"] },
    { episodeId: "gone", guests: ["לא קיים"] },
  ], seasons);
  const e1 = out.find((row) => row.episodeId === "e1");
  assert.deepEqual(e1.add.map((a) => [a.name, a.checked]), [["קובי בלום", false]], "a host named in the season title is offered unchecked");
  assert.match(e1.add[0].reason, /מגיש/);
  const e2 = out.find((row) => row.episodeId === "e2");
  assert.deepEqual(e2.add.map((a) => a.name), ["יואלי קליין", "מוטי שטיינמץ"], "the catalog spelling is reused");
  assert.ok(!out.some((row) => row.episodeId === "gone"));
  const applied = applyGuestSuggestions(eps, [{ episodeId: "e2", names: ["מוטי שטיינמץ", "מוטי  שטיינמץ"] }]);
  assert.deepEqual(applied[1].guests, ["מוטי שטיינמץ"]);
  assert.equal(applied[0], eps[0]);
});

test("guest profiles publish with the catalog and reach the public catalog", async () => {
  const { call, admin } = await setup();
  const write = await publish(call, admin, { settings: { guests: [{ name: "יואלי קליין", role: "זמר ומלחין", bio: "קול מוכר", photo: "https://example.com/p.jpg", links: [{ label: "", url: "https://youtube.com/" }] }, { name: "ריק" }] } });
  assert.equal(write.status, 200, await write.clone().text());
  const pub = await (await call("/api/program/catalog")).json();
  assert.equal(pub.settings.guests.length, 1);
  assert.equal(pub.settings.guests[0].role, "זמר ומלחין");
  // פרסום בלי השדה guests אינו מוחק את הפרופילים
  assert.equal((await publish(call, admin, { settings: { updates: [] } })).status, 200);
  assert.equal((await (await call("/api/program/catalog")).json()).settings.guests.length, 1);
});

test("the guests found in transcript summaries are listed for administrators only", async () => {
  const { call, admin, voter, db } = await setup();
  await publish(call, admin);
  db.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total,summary_json) VALUES ('ep-1','תמלול',1,1,?)").run(JSON.stringify({ description: "", summary: "", tags: [], guests: ["מוטי שטיינמץ", ""] }));
  db.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total) VALUES ('ep-2','תמלול',2,2)").run();
  db.prepare("INSERT INTO program_transcripts (episode_id,text,parts_done,parts_total) VALUES ('ep-3','חלקי',1,2)").run();
  assert.equal((await call("/api/program/ai/guests", { token: voter })).status, 403);
  const res = await call("/api/program/ai/guests", { token: admin });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.items, [{ episodeId: "ep-1", guests: ["מוטי שטיינמץ"] }]);
  assert.deepEqual(body.pending, ["ep-2"], "only finished transcripts without a summary are pending");
});
