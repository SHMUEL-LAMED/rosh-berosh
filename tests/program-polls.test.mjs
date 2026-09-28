import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * סקרים באתר התוכניות: ההגדרה מתפרסמת עם הקטלוג, ההצבעה של מאזין מחובר,
 * מי רואה תוצאות, ואיפוס בידי מנהל — מול הוורקר הבנוי ו־SQLite אמיתי.
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


const poll = (extra = {}) => ({
  id: "p1", enabled: true, title: "השיר של השבוע", question: "איזה שיר הכי אהבתם?",
  options: [{ id: "a", label: "שיר א", sub: "זמר א", image: "https://media.example/a.jpg" }, { id: "b", label: "שיר ב" }, { id: "c", label: "שיר ג" }],
  show: { home: true, episodes: ["ep-1"] }, ...extra,
});
const status = async (call, token, ids = "p1") => (await (await call(`/api/program/polls?ids=${ids}`, { token })).json()).polls;
const vote = (db, call, token, choices, pollId = "p1") => { db.prepare("DELETE FROM ballot_rate_limits").run(); return call("/api/program/polls/vote", { method: "POST", token, body: { pollId, choices } }); };

test("a poll publishes with the catalog, cleaned up; the public sees only enabled polls that started", async () => {
  const { call, admin } = await setup();
  const write = await publish(call, admin, { settings: { polls: [
    poll({ junk: 1, layout: "nope", optionShape: "square", optionSize: "l", hue: 400, image: "javascript:alert(1)", options: [{ id: "a", label: "שיר א", image: "http://x/y.jpg" }, { id: "a", label: "שוב א" }, { label: "" }, { id: "b", label: "שיר ב" }] }),
    poll({ id: "draft", enabled: false }),
    poll({ id: "later", from: "2099-01-01T10:00" }),
    poll({ id: "one", options: [{ id: "a", label: "רק אחת" }] }),
  ] } });
  assert.equal(write.status, 200, await write.clone().text());
  const pub = (await (await call("/api/program/catalog")).json()).settings.polls;
  assert.deepEqual(pub.map((p) => p.id), ["p1"], "drafts, future polls and polls with one option stay hidden");
  const p = pub[0];
  assert.equal(p.layout, "list", "unknown layout falls back");
  assert.equal(p.optionShape, "square");
  assert.equal(p.optionSize, "l");
  assert.equal(p.hue, 40);
  assert.equal(p.image, "", "only https images");
  assert.equal("junk" in p, false);
  assert.deepEqual(p.options.map((o) => [o.id, o.label, o.image]), [["a", "שיר א", ""], ["ax", "שוב א", ""], ["b", "שיר ב", ""]], "duplicate ids get a new id, empty options are dropped");
  const adm = (await (await call("/api/program/catalog", { token: admin })).json()).settings.polls;
  assert.deepEqual(adm.map((x) => x.id), ["p1", "draft", "later", "one"], "admins get every poll back to edit");
  assert.equal(adm.find((x) => x.id === "one").enabled, false, "a poll with one option cannot be enabled");
  // a publish without polls keeps them
  await publish(call, admin, {});
  assert.equal((await (await call("/api/program/catalog")).json()).settings.polls.length, 1);
});

test("voting needs a session, a valid choice and an open poll; results show after voting", async () => {
  const { db, call, admin, voter, other } = await setup();
  await publish(call, admin, { settings: { polls: [poll()] } });
  assert.equal((await vote(db, call, null, ["a"])).status, 401);
  assert.equal((await vote(db, call, voter, [])).status, 400);
  assert.equal((await vote(db, call, voter, ["zzz"])).status, 400);
  assert.equal((await vote(db, call, voter, ["a", "b"])).status, 400, "single choice");
  assert.equal((await vote(db, call, voter, ["a"], "nope")).status, 404);
  let st = (await status(call, voter)).p1;
  assert.equal(st.open, true);
  assert.equal(st.counts, null, "results stay hidden before voting");
  const r = await vote(db, call, voter, ["a"]);
  assert.equal(r.status, 200, await r.clone().text());
  st = (await r.json()).poll;
  assert.deepEqual(st.mine, ["a"]);
  assert.deepEqual(st.counts, { a: 1, b: 0, c: 0 });
  assert.equal(st.total, 1);
  await vote(db, call, other, ["b"]);
  // changing a vote replaces it
  await vote(db, call, voter, ["b"]);
  st = (await status(call, voter)).p1;
  assert.deepEqual(st.counts, { a: 0, b: 2, c: 0 });
  assert.deepEqual(st.mine, ["b"]);
  assert.equal((await status(call, null)).p1.counts, null, "someone who did not vote does not see results");
  assert.deepEqual((await status(call, admin)).p1.counts, { a: 0, b: 2, c: 0 }, "admins always see results");
});

test("multiple choice, no changing, results policy and closing", async () => {
  const { db, call, admin, voter, other } = await setup();
  await publish(call, admin, { settings: { polls: [
    poll({ multi: true, maxChoices: 2, allowChange: false, results: "closed" }),
    poll({ id: "p2", results: "always" }),
    poll({ id: "p3", results: "admin" }),
    poll({ id: "old", until: "2000-01-01T00:00", results: "after" }),
  ] } });
  assert.equal((await vote(db, call, voter, ["a", "b", "c"])).status, 400, "at most two");
  assert.equal((await vote(db, call, voter, ["a", "c"])).status, 200);
  assert.equal((await vote(db, call, voter, ["b"])).status, 409, "no changing");
  assert.equal((await status(call, voter)).p1.counts, null, "results only after the poll closes");
  assert.deepEqual((await status(call, other, "p2")).p2.counts, { a: 0, b: 0, c: 0 }, "always: visible before voting");
  await vote(db, call, voter, ["a"], "p3");
  assert.equal((await status(call, voter, "p3")).p3.counts, null, "admin-only results");
  assert.equal((await vote(db, call, voter, ["a"], "old")).status, 409, "closed");
  const old = (await status(call, other, "old")).old;
  assert.equal(old.closed, true);
  assert.deepEqual(old.counts, { a: 0, b: 0, c: 0 }, "after closing everyone sees the results");
});

test("an admin can reset a poll's votes; listeners cannot", async () => {
  const { db, call, admin, voter } = await setup();
  await publish(call, admin, { settings: { polls: [poll()] } });
  await vote(db, call, voter, ["a"]);
  assert.equal((await call("/api/program/polls/reset", { method: "POST", token: voter, body: { pollId: "p1" } })).status, 403);
  assert.equal((await call("/api/program/polls/reset", { method: "POST", token: admin, body: { pollId: "p1" } })).status, 200);
  const st = (await status(call, admin)).p1;
  assert.equal(st.total, 0);
  assert.deepEqual(st.mine, []);
});

/* ---------- הניהול המאוחד: שמירה ופרסום אינם מוחקים ואינם משנים סקרים שלא נערכו ---------- */

const catalogAsAdmin = async (call, token) => (await call("/api/program/catalog", { token })).json();
const getDraft = async (call, token) => (await (await call("/api/program/draft", { token })).json()).draft;
const putDraft = (call, token, data) => call("/api/program/draft", { method: "PUT", token, body: { data } });
// הניהול הישן (rosh-berosh-2 store.js) טוען טיוטה בלי השדה כ"אין סקרים" ומפרסם polls: [] — כך נמחקו הסקרים
const oldAdminPublish = (call, token, draft) => publish(call, token, { settings: { ...draft.settings, polls: draft.settings.polls || [] } });

test("a draft saved without polls (the unified admin before this fix) keeps the polls, so the old admin cannot wipe them", async () => {
  const { call, admin } = await setup();
  await publish(call, admin, { settings: { polls: [poll(), poll({ id: "p2", enabled: false, question: "טיוטה" })] } });
  const before = (await catalogAsAdmin(call, admin)).settings.polls;
  assert.equal(before.length, 2);

  // שמירת טיוטה בלי settings.polls — מה שהניהול המאוחד שלח עד עכשיו בכל שינוי
  assert.equal((await putDraft(call, admin, { seasons: [], episodes: [episode("ep-1")], settings: { banner: { enabled: true, text: "שלום" } } })).status, 200);
  let draft = await getDraft(call, admin);
  assert.deepEqual(draft.data.settings.polls, before, "the draft gets the published polls instead of none");
  assert.equal(draft.data.settings.banner.text, "שלום");

  // הניהול הישן טוען את הטיוטה ומפרסם — הסקרים נשארים בדיוק כמו שהיו
  assert.equal((await oldAdminPublish(call, admin, draft.data)).status, 200);
  assert.deepEqual((await catalogAsAdmin(call, admin)).settings.polls, before, "publishing the loaded draft does not delete or alter polls");

  // עריכה של סקר בטיוטה (שעוד לא פורסמה) שורדת שמירה בלי השדה
  const edited = [{ ...before[0], question: "שאלה חדשה" }, before[1]];
  await putDraft(call, admin, { seasons: [], episodes: [episode("ep-1")], settings: { polls: edited } });
  await putDraft(call, admin, { seasons: [], episodes: [episode("ep-1")], settings: { banner: { enabled: false } } });
  draft = await getDraft(call, admin);
  assert.deepEqual(draft.data.settings.polls, edited, "unpublished poll edits in the previous draft are kept");

  // מחיקה מפורשת של כל הסקרים (polls: []) — נשמרת כמו שהיא
  await putDraft(call, admin, { seasons: [], episodes: [episode("ep-1")], settings: { polls: [] } });
  assert.deepEqual((await getDraft(call, admin)).data.settings.polls, []);
  // טיוטה בלי settings בכלל לא מקבלת הגדרות (פרסום שלה לא נוגע בהן)
  await putDraft(call, admin, { seasons: [], episodes: [episode("ep-1")] });
  assert.equal("settings" in (await getDraft(call, admin)).data, false);
});

test("a stored legacy draft without polls is served with the published polls (draft and preview)", async () => {
  const { db, call, admin } = await setup();
  await publish(call, admin, { settings: { polls: [poll()] } });
  const published = (await catalogAsAdmin(call, admin)).settings.polls;
  db.prepare("INSERT INTO program_settings (key,value_json,updated_at) VALUES ('draft',?,unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
    .run(JSON.stringify({ data: { seasons: [], episodes: [episode("ep-1")], settings: { banner: { enabled: false } } }, updatedAt: "2026-09-01T00:00:00.000Z", by: "admin@example.com" }));
  assert.deepEqual((await getDraft(call, admin)).data.settings.polls, published);
  const { preview } = await (await call("/api/program/preview", { method: "POST", token: admin })).json();
  const shared = await (await call(`/api/program/preview/${preview.token}`)).json();
  assert.deepEqual(shared.data.settings.polls, published, "the preview link shows the polls too");
});

test("the unified admin's catalog round-trip keeps polls exactly as they are", async (t) => {
  const core = await import("../app/admin/programs-core.ts").catch(() => null);
  if (!core) { t.skip("this Node cannot load TypeScript directly"); return; }
  const { call, admin } = await setup();
  await publish(call, admin, { settings: { polls: [poll({ from: "2099-01-01T10:00" }), poll({ id: "off", enabled: false })] } });
  const loaded = core.normCatalog(await catalogAsAdmin(call, admin));
  const before = loaded.settings.polls;
  assert.equal(before.length, 2, "the admin catalog carries every poll, also future and disabled ones");
  // בדיוק מה שהניהול המאוחד שולח בפרסום (PublishSection): settings: data.settings
  const write = await call("/api/program/catalog", { method: "POST", token: admin, body: { seasons: loaded.seasons, episodes: loaded.episodes.map((e) => core.normEpisode(e, 0)), removedIds: [], settings: { ...loaded.settings, banner: { ...loaded.settings.banner, text: "חדש", enabled: true } } } });
  assert.equal(write.status, 200, await write.clone().text());
  assert.deepEqual((await catalogAsAdmin(call, admin)).settings.polls, before, "publishing an unrelated change leaves polls untouched");
  // שדה חסר נשאר חסר (ולא הופך ל"אין סקרים")
  assert.equal(core.normCatalog({ settings: { banner: {} } }).settings.polls, undefined);
  const odd = [{ id: "x", question: "?", extra: 1 }];
  assert.deepEqual(core.normCatalog({ settings: { polls: odd } }).settings.polls, odd, "polls are carried as they are, not re-normalized");
});

test("shared poll rules: withPolls never drops the field, and an edited poll publishes exactly as saved", async () => {
  const shared = await import("../worker/program-polls-shared.js");
  assert.deepEqual(shared.withPolls({ banner: 1 }, undefined, [{ id: "a" }]), { banner: 1, polls: [{ id: "a" }] });
  assert.deepEqual(shared.withPolls({ polls: [] }, [{ id: "a" }]), { polls: [] }, "an explicit empty list stays");
  assert.deepEqual(shared.withPolls({ banner: 1 }), { banner: 1 });
  assert.equal(shared.pollsIn({}), undefined);

  const draft = shared.blankPoll({ question: "מי הזמר שלכם?", show: { home: true, archive: false, me: false, allEpisodes: false, episodes: ["ep-1"] }, from: "2026-01-01T09:00", until: "2099-01-01T20:00", results: "closed", multi: true, maxChoices: 2 });
  draft.options = [{ id: "a", label: "זמר א", sub: "", image: "https://media.example/a.jpg" }, { id: "b", label: "זמר ב", sub: "להקה", image: "" }, { id: "c", label: "", sub: "", image: "" }];
  const saved = shared.pollForSave(draft);
  assert.deepEqual(saved.options.map((o) => o.id), ["a", "b"], "empty answers are dropped on save");
  assert.deepEqual(shared.pollProblems(saved), []);
  assert.equal(shared.pollState(saved, "2026-06-01T12:00").cls, "live");
  assert.equal(shared.pollState(saved, "2025-06-01T12:00").cls, "soon");
  assert.equal(shared.pollState({ ...saved, until: "2026-02-01T00:00" }, "2026-06-01T12:00").cls, "closed");
  assert.deepEqual(shared.pollPlaces(saved, () => "תוכנית 1"), ["דף הבית", "דף תוכנית: תוכנית 1"]);

  const { call, admin } = await setup();
  await publish(call, admin, { settings: { polls: [saved] } });
  const [back] = (await catalogAsAdmin(call, admin)).settings.polls;
  assert.deepEqual(back, saved, "the server keeps every field the admin wrote (polls.js reads the same shape)");
});

test("admin live results: per option (also removed options), voters and last vote; listeners are refused", async () => {
  const { db, call, admin, voter, other } = await setup();
  await publish(call, admin, { settings: { polls: [poll({ multi: true, maxChoices: 2 })] } });
  await vote(db, call, voter, ["a", "b"]);
  await vote(db, call, other, ["a"]);
  assert.equal((await call("/api/program/polls/results?ids=p1", { token: voter })).status, 403);
  assert.equal((await call("/api/program/polls/results?ids=p1")).status, 403);
  let r = (await (await call("/api/program/polls/results?ids=p1,draft-only", { token: admin })).json()).results;
  assert.equal(r.p1.total, 2);
  assert.deepEqual(r.p1.counts, { a: 2, b: 1 });
  assert.equal(r.p1.published, true);
  assert.equal(r.p1.open, true);
  assert.ok(r.p1.lastVoteAt > 0);
  assert.deepEqual(r["draft-only"], { total: 0, counts: {}, lastVoteAt: null, published: false, open: false, closed: false }, "a poll that is only in the draft has no votes yet");
  // תשובה שנמחקה מהסקר — הספירה שלה עדיין מוחזרת למנהל
  await publish(call, admin, { settings: { polls: [poll({ multi: true, maxChoices: 2, options: [{ id: "a", label: "שיר א" }, { id: "c", label: "שיר ג" }] })] } });
  r = (await (await call("/api/program/polls/results?ids=p1", { token: admin })).json()).results;
  assert.deepEqual(r.p1.counts, { a: 2, b: 1 });
  await call("/api/program/polls/reset", { method: "POST", token: admin, body: { pollId: "p1" } });
  r = (await (await call("/api/program/polls/results?ids=p1", { token: admin })).json()).results;
  assert.equal(r.p1.total, 0);
  assert.deepEqual(r.p1.counts, {});
});
