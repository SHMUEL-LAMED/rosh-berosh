import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyGuestSuggestions, collectGuests, guestKey, guestSuggestions, normalizeGuests, removeGuest, renameGuest, withPublishedPhotos } from "../worker/program-guests.js";

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

/* ---------- תמונות פרופיל שכבר באתר מול טיוטה שאינה מכירה אותן ---------- */

const PHOTO = "https://rosh-berosh.smwlyqswkwt232.workers.dev/api/program/profile-photo/yoeli-klein";
const readDraft = async (call, token) => (await (await call("/api/program/draft", { token })).json()).draft;
const storeDraft = (db, data) => db.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('draft',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
  .run(JSON.stringify({ data, updatedAt: "2026-09-01T00:00:00.000Z", by: "admin@example.com" }));
const storedDraft = (db) => JSON.parse(db.prepare("SELECT value_json FROM program_settings WHERE key='draft'").get().value_json).data;

test("a draft that does not know the published photos gets them; removed guests do not come back", () => {
  const published = [
    { name: "יואלי קליין", role: "זמר", bio: "", photo: PHOTO, links: [] },
    { name: "בלי תמונה", role: "מלחין", bio: "", photo: "", links: [] },
    { name: "הוסר", role: "", bio: "", photo: "https://example.com/gone.jpg", links: [] },
    { name: "חבר פאנל", role: "חבר פאנל", bio: "בפאנל", photo: "https://example.com/panel.jpg", links: [{ label: "", url: "https://example.com/" }] },
  ];
  const draft = {
    seasons: [], episodes: [{ id: "a", guests: ["יואלי  קליין", "בלי תמונה"], panelists: ["חבר פאנל"] }],
    settings: { banner: { enabled: false }, guests: [{ name: "יואלי קליין", role: "זמר ומלחין", bio: "", photo: "", links: [] }, { name: "שלי", role: "", bio: "", photo: "https://example.com/mine.jpg", links: [] }] },
  };
  const out = withPublishedPhotos(draft, published);
  assert.notEqual(out, draft);
  assert.equal(out.episodes, draft.episodes, "the episodes are untouched");
  assert.equal(out.settings.banner, draft.settings.banner, "other settings are untouched");
  assert.deepEqual(out.settings.guests, [
    { name: "יואלי קליין", role: "זמר ומלחין", bio: "", photo: PHOTO, links: [] },   // the draft's edits stay, the photo comes from the site
    { name: "שלי", role: "", bio: "", photo: "https://example.com/mine.jpg", links: [] },   // a photo of its own is kept
    published[3],   // in the draft's episodes without a profile there — the published profile comes in as it is
  ]);
  // "הוסר" is in no episode of the draft, so it is not brought back; "בלי תמונה" has nothing to fill
  assert.equal(withPublishedPhotos(out, published), out, "nothing left to fill — the same object");
  assert.equal(withPublishedPhotos({ seasons: [], episodes: draft.episodes }, published).settings, undefined, "a draft without settings stays without them");
  assert.equal(withPublishedPhotos(draft, []), draft);
  // the worker's own photo proxy and R2 media urls pass normalization untouched
  assert.equal(normalizeGuests([{ name: "יואלי קליין", photo: PHOTO }])[0].photo, PHOTO);
  assert.equal(normalizeGuests([{ name: "יואלי קליין", photo: "https://rosh-berosh.smwlyqswkwt232.workers.dev/media/program/guests/x.jpg" }])[0].photo, "https://rosh-berosh.smwlyqswkwt232.workers.dev/media/program/guests/x.jpg");
});

test("photos already on the site survive an old draft: the admin gets them, saving keeps them, publishing does not wipe them", async () => {
  const { db, call, admin } = await setup();
  const episode = { id: "ep-1", slug: "ep-1", title: "תוכנית", date: "2026-09-01", visible: true, guests: ["יואלי קליין"], panelists: ["חבר פאנל"] };
  await publish(call, admin, { episodes: [episode], settings: { guests: [{ name: "יואלי קליין", role: "זמר", bio: "", photo: PHOTO, links: [] }, { name: "חבר פאנל", role: "חבר פאנל", photo: "https://example.com/panel.jpg" }] } });
  // the admin's catalog carries the photos
  const adminCatalog = await (await call("/api/program/catalog", { token: admin })).json();
  assert.deepEqual(adminCatalog.settings.guests.map((g) => g.photo), [PHOTO, "https://example.com/panel.jpg"]);

  // a draft saved before the photos were added: the profile without a photo, the panelist without a profile
  storeDraft(db, { seasons: [], episodes: [episode], settings: { banner: { enabled: false }, guests: [{ name: "יואלי קליין", role: "זמר ומלחין", bio: "", photo: "", links: [] }] } });
  const draft = await readDraft(call, admin);
  assert.deepEqual(draft.data.settings.guests, [
    { name: "יואלי קליין", role: "זמר ומלחין", bio: "", photo: PHOTO, links: [] },
    { name: "חבר פאנל", role: "חבר פאנל", bio: "", photo: "https://example.com/panel.jpg", links: [] },
  ], "the draft is served with the published photos");
  assert.equal(draft.updatedAt, "2026-09-01T00:00:00.000Z");
  const { preview } = await (await call("/api/program/preview", { method: "POST", token: admin })).json();
  const shared = await (await call(`/api/program/preview/${preview.token}`)).json();
  assert.equal(shared.data.settings.guests[0].photo, PHOTO, "the preview link shows the photos too");

  // editing role and bio and saving the draft (what the unified admin sends) keeps the photo — also in the stored draft
  const edited = { ...draft.data, settings: { ...draft.data.settings, guests: draft.data.settings.guests.map((g) => ({ ...g, bio: "כמה מילים" })) } };
  assert.equal((await call("/api/program/draft", { method: "PUT", token: admin, body: { data: edited } })).status, 200);
  assert.deepEqual(storedDraft(db).settings.guests.map((g) => [g.photo, g.bio]), [[PHOTO, "כמה מילים"], ["https://example.com/panel.jpg", "כמה מילים"]]);
  // a save from a tab that does not know the photos does not strip them from the draft
  assert.equal((await call("/api/program/draft", { method: "PUT", token: admin, body: { data: { ...edited, settings: { ...edited.settings, guests: [{ name: "יואלי קליין", role: "זמר", bio: "", photo: "", links: [] }] } } } })).status, 200);
  assert.deepEqual(storedDraft(db).settings.guests.map((g) => g.photo), [PHOTO, "https://example.com/panel.jpg"]);

  // publishing the loaded draft (settings as they came back) keeps the photos on the public site
  const loaded = (await readDraft(call, admin)).data;
  assert.equal((await publish(call, admin, { episodes: loaded.episodes, settings: loaded.settings })).status, 200);
  const pub = await (await call("/api/program/catalog")).json();
  assert.deepEqual(pub.settings.guests.map((g) => [g.name, g.photo]), [["יואלי קליין", PHOTO], ["חבר פאנל", "https://example.com/panel.jpg"]]);
  // removing a photo on purpose still publishes as a removal
  assert.equal((await publish(call, admin, { episodes: loaded.episodes, settings: { guests: [{ ...pub.settings.guests[0], photo: "" }, pub.settings.guests[1]] } })).status, 200);
  assert.deepEqual((await (await call("/api/program/catalog")).json()).settings.guests.map((g) => g.photo), ["", "https://example.com/panel.jpg"]);
});

test("the unified admin fills the photos at load, against the catalog it loaded", async (t) => {
  const core = await import("../app/admin/programs-core.ts").catch(() => null);
  if (!core) { t.skip("this Node cannot load TypeScript directly"); return; }
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../app/admin/programs-admin.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("withPublishedPhotos(draft?.data ? normCatalog(draft.data) : pub, pub.settings.guests)"), "programs-admin.tsx fills the draft from the loaded catalog");
  const episode = { id: "ep-1", slug: "ep-1", title: "תוכנית", date: "2026-09-01", visible: true, guests: ["יואלי קליין"], panelists: ["חבר פאנל"] };
  const pub = core.normCatalog({ seasons: [], episodes: [episode], settings: { guests: [{ name: "יואלי קליין", role: "זמר", photo: PHOTO }, { name: "חבר פאנל", role: "חבר פאנל", photo: "https://example.com/panel.jpg" }] } });
  const draft = core.normCatalog({ seasons: [], episodes: [episode], settings: { guests: [{ name: "יואלי קליין", role: "זמר ומלחין" }] } });
  const loaded = withPublishedPhotos(draft, pub.settings.guests);
  const shown = Object.fromEntries(collectGuests(loaded.episodes, loaded.settings.guests).map((g) => [g.name, [g.profile?.photo, g.profile?.role]]));
  assert.deepEqual(shown, { "יואלי קליין": [PHOTO, "זמר ומלחין"], "חבר פאנל": ["https://example.com/panel.jpg", "חבר פאנל"] }, "every guest and panelist shows the photo the site already has");
  assert.equal(withPublishedPhotos(pub, pub.settings.guests), pub, "without a draft nothing changes");
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
