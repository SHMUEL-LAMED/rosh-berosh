import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { LINE_SETTINGS_DEFAULTS, LINE_SETTINGS_LIMITS, describeLineSettings, emptyLineSettings, lineSettingsForIvr, parseStoredLineSettings, validateLineSettings } from "../worker/ivr-line-settings.js";

const require = createRequire(import.meta.url);
const { LINE_SETTING_DEFAULTS, LINE_SETTING_LIMITS, createLineSettingsLoader, resolveLineSettings, withMenuRepeats } = require("../ivr-service/src/line-settings.js");
const { continuousMenuInput, menuReadOptions, naturalMenuInput, votingReadOptions } = require("../ivr-service/src/menu-input.js");
const { adminReadOptions } = require("../ivr-service/src/admin-menu.js");
const { resolvePostVoteTransfer } = require("../ivr-service/src/phone.js");

const HEBREW = /[֐-׿]/;

// ---------- בדיקת הקלט באתר ----------

test("the transfer number accepts an Israeli number, off, or empty for the default", () => {
  const ok = (value) => validateLineSettings({ postVoteTransfer: value }).settings;
  assert.deepEqual(ok("0796077075"), { ...emptyLineSettings(), transferNumber: "0796077075" });
  assert.equal(ok("021234567").transferNumber, "021234567", "9 ספרות (קו נייח) תקינות");
  assert.equal(ok(" 079-607-7075 ").transferNumber, "0796077075", "רווחים ומקפים הם עיצוב בלבד");
  assert.equal(lineSettingsForIvr(ok("")).postVoteTransfer, "", "ריק = ברירת המחדל של שרת הקו");
  assert.equal(lineSettingsForIvr(ok(null)).postVoteTransfer, "");
  for (const off of ["off", "OFF", " Off "]) assert.equal(lineSettingsForIvr(ok(off)).postVoteTransfer, "off", off);

  for (const bad of ["abc", "+972796077075", "972796077075", "79607707", "07960770751", "1796077075", "0796O77075", "0", "none", 5, true, {}, []]) {
    const result = validateLineSettings({ postVoteTransfer: bad });
    assert.ok(result.error, `${JSON.stringify(bad)} היה צריך להידחות`);
    assert.match(result.error, HEBREW);
  }
});

test("turning the transfer off remembers the number for later", () => {
  const withNumber = validateLineSettings({ postVoteTransfer: "0501234567" }).settings;
  const off = validateLineSettings({ postVoteTransfer: "off" }, withNumber).settings;
  assert.equal(off.transferEnabled, false);
  assert.equal(off.transferNumber, "0501234567");
  assert.equal(lineSettingsForIvr(off).postVoteTransfer, "off");
  const backOn = validateLineSettings({ postVoteTransfer: "0501234567" }, off).settings;
  assert.equal(lineSettingsForIvr(backOn).postVoteTransfer, "0501234567");
  // הטופס שולח את המספר גם כשהמתג כבוי, כדי שיישמר.
  const offWithTyped = validateLineSettings({ postVoteTransfer: "off", transferNumber: "0771234567" }).settings;
  assert.equal(offWithTyped.transferNumber, "0771234567");
  assert.ok(validateLineSettings({ postVoteTransfer: "off", transferNumber: "12" }).error);
});

test("wait times and repeats are whole numbers inside their bounds", () => {
  const cases = [
    ["votingWaitSeconds", [7, 20, 60, "30"], [6, 61, 0, -5, 7.5, "abc", "7.5", "", true]],
    ["adminWaitSeconds", [2, 5, 20], [1, 21, 2.5, "x"]],
    ["menuRepeats", [0, 3, 5, "0"], [6, -1, 1.5, "two"]],
  ];
  for (const [key, good, bad] of cases) {
    for (const value of good) {
      const result = validateLineSettings({ [key]: value });
      assert.equal(result.error, undefined, `${key}=${JSON.stringify(value)}`);
      assert.equal(result.settings[key], Number(value));
    }
    for (const value of bad) {
      if (value === "") continue;
      const result = validateLineSettings({ [key]: value });
      assert.ok(result.error, `${key}=${JSON.stringify(value)} היה צריך להידחות`);
      assert.match(result.error, HEBREW);
      assert.match(result.error, new RegExp(`${LINE_SETTINGS_LIMITS[key].min}.*${LINE_SETTINGS_LIMITS[key].max}`));
    }
    assert.equal(validateLineSettings({ [key]: "" }).settings[key], null, "ריק מחזיר לברירת המחדל");
    assert.equal(validateLineSettings({ [key]: null }).settings[key], null);
  }
  for (const body of [null, "x", 7, []]) assert.ok(validateLineSettings(body).error);
});

test("a save merges: omitted fields stay, null resets to the default", () => {
  const first = validateLineSettings({ postVoteTransfer: "0501234567", votingWaitSeconds: 30, adminWaitSeconds: 4, menuRepeats: 2 }).settings;
  const partial = validateLineSettings({ menuRepeats: 1 }, first).settings;
  assert.deepEqual(partial, { ...first, menuRepeats: 1 });
  const reset = validateLineSettings({ votingWaitSeconds: null }, first).settings;
  assert.equal(reset.votingWaitSeconds, null);
  assert.equal(reset.adminWaitSeconds, 4);
  // בקשה פסולה אינה משנה דבר, גם אם שדות אחרים בה תקינים.
  assert.ok(validateLineSettings({ menuRepeats: 1, votingWaitSeconds: 500 }, first).error);
});

test("a damaged stored row never breaks the line", () => {
  assert.deepEqual(parseStoredLineSettings("{not json").settings, emptyLineSettings());
  assert.deepEqual(parseStoredLineSettings(null).settings, emptyLineSettings());
  const parsed = parseStoredLineSettings(JSON.stringify({ transferNumber: "zzz", transferEnabled: false, votingWaitSeconds: 999, adminWaitSeconds: 3, menuRepeats: "2", updatedAt: 1700000000, updatedBy: "a@b.c" }));
  assert.deepEqual(parsed.settings, { transferNumber: "", transferEnabled: false, votingWaitSeconds: null, adminWaitSeconds: 3, menuRepeats: 2 });
  assert.equal(parsed.updatedAt, 1700000000);
  assert.equal(parsed.updatedBy, "a@b.c");
});

test("the admin view reports the effective value and where it comes from", () => {
  const none = describeLineSettings(emptyLineSettings());
  assert.deepEqual(none.effective, { postVoteTransfer: "0796077075", transferEnabled: true, votingWaitSeconds: 20, adminWaitSeconds: 5, menuRepeats: 0 });
  assert.deepEqual(none.sources, { postVoteTransfer: "default", votingWaitSeconds: "default", adminWaitSeconds: "default", menuRepeats: "default" });
  const set = describeLineSettings(validateLineSettings({ postVoteTransfer: "off", votingWaitSeconds: 25 }).settings);
  assert.equal(set.effective.transferEnabled, false);
  assert.equal(set.sources.postVoteTransfer, "admin");
  assert.equal(set.effective.votingWaitSeconds, 25);
  assert.equal(set.sources.votingWaitSeconds, "admin");
  assert.equal(set.sources.menuRepeats, "default");
});

test("the site and the phone service agree on defaults and bounds", () => {
  assert.deepEqual({ ...LINE_SETTING_DEFAULTS }, { ...LINE_SETTINGS_DEFAULTS });
  assert.deepEqual(JSON.parse(JSON.stringify(LINE_SETTING_LIMITS)), JSON.parse(JSON.stringify(LINE_SETTINGS_LIMITS)));
});

// ---------- סדר העדיפות בשירות הקו ----------

// הנוסחאות שהיו בשירות לפני ההגדרה מהאתר. בלי הגדרה באתר התוצאה חייבת להיות זהה.
const legacy = (env) => ({
  postVoteTransfer: resolvePostVoteTransfer(env.POST_VOTE_TRANSFER),
  votingWaitSeconds: Math.min(Math.max(Number(env.IVR_SEC_WAIT) || 20, 7), 60),
  adminWaitSeconds: Math.min(Math.max(Number(env.IVR_MENU_SEC_WAIT) || 5, 2), 20),
});

test("with nothing set on the site the line behaves exactly as before", () => {
  const envs = [
    {},
    { POST_VOTE_TRANSFER: "off" },
    { POST_VOTE_TRANSFER: "077-1234567", IVR_SEC_WAIT: "30", IVR_MENU_SEC_WAIT: "3" },
    { IVR_SEC_WAIT: "3", IVR_MENU_SEC_WAIT: "99" },
    { IVR_SEC_WAIT: "abc", IVR_MENU_SEC_WAIT: "" },
    { POST_VOTE_TRANSFER: "0" },
  ];
  for (const env of envs) {
    for (const site of [null, undefined, {}, { postVoteTransfer: "", votingWaitSeconds: null, adminWaitSeconds: null, menuRepeats: null }]) {
      const resolved = resolveLineSettings(site, env);
      const { sources, menuRepeats, ...values } = resolved;
      assert.deepEqual(values, legacy(env), `${JSON.stringify(env)} / ${JSON.stringify(site)}`);
      assert.equal(menuRepeats, 0);
      assert.ok(sources);
    }
  }
  assert.deepEqual(resolveLineSettings(null, {}).sources, { postVoteTransfer: "default", votingWaitSeconds: "default", adminWaitSeconds: "default", menuRepeats: "default" });
});

test("a value from the site wins over the environment, which wins over the default", () => {
  const env = { POST_VOTE_TRANSFER: "0771234567", IVR_SEC_WAIT: "30", IVR_MENU_SEC_WAIT: "3", IVR_MENU_REPEATS: "1" };
  const fromEnv = resolveLineSettings(null, env);
  assert.deepEqual(fromEnv, { postVoteTransfer: "0771234567", votingWaitSeconds: 30, adminWaitSeconds: 3, menuRepeats: 1, sources: { postVoteTransfer: "env", votingWaitSeconds: "env", adminWaitSeconds: "env", menuRepeats: "env" } });

  const fromSite = resolveLineSettings({ postVoteTransfer: "0501234567", votingWaitSeconds: 40, adminWaitSeconds: 8, menuRepeats: 3 }, env);
  assert.deepEqual(fromSite, { postVoteTransfer: "0501234567", votingWaitSeconds: 40, adminWaitSeconds: 8, menuRepeats: 3, sources: { postVoteTransfer: "site", votingWaitSeconds: "site", adminWaitSeconds: "site", menuRepeats: "site" } });

  // כיבוי באתר גובר על מספר בשרת, ומספר באתר גובר על כיבוי בשרת.
  assert.equal(resolveLineSettings({ postVoteTransfer: "off" }, env).postVoteTransfer, "");
  assert.equal(resolveLineSettings({ postVoteTransfer: "0501234567" }, { POST_VOTE_TRANSFER: "off" }).postVoteTransfer, "0501234567");

  // ערך חלקי: מה שנקבע באתר נלקח משם, והשאר ממשתני הסביבה.
  const mixed = resolveLineSettings({ menuRepeats: 2 }, env);
  assert.equal(mixed.menuRepeats, 2);
  assert.equal(mixed.votingWaitSeconds, 30);
  assert.equal(mixed.sources.votingWaitSeconds, "env");
});

test("an invalid value from the site is ignored, not trusted", () => {
  const env = { IVR_SEC_WAIT: "30" };
  const resolved = resolveLineSettings({ postVoteTransfer: "12345", votingWaitSeconds: 2, adminWaitSeconds: "8", menuRepeats: 9 }, env);
  assert.equal(resolved.postVoteTransfer, "0796077075");
  assert.equal(resolved.votingWaitSeconds, 30);
  assert.equal(resolved.adminWaitSeconds, 5);
  assert.equal(resolved.menuRepeats, 0);
});

test("menus pick up the call's wait times and repeats", () => {
  const timing = { votingWaitSeconds: 33, adminWaitSeconds: 9, menuRepeats: 2 };
  assert.equal(menuReadOptions([1, 2], timing).sec_wait, 33);
  assert.equal(menuReadOptions([1, 2], timing).amount_attempts, 3, "שתי חזרות = שלוש השמעות");
  assert.equal(continuousMenuInput(12, true, timing).read.sec_wait, 33);
  assert.equal(continuousMenuInput(12, true, timing).read.amount_attempts, 3);
  assert.equal(naturalMenuInput(30, true, timing).read.sec_wait, 9);
  assert.equal(adminReadOptions(timing).sec_wait, 9);
  assert.equal(adminReadOptions(timing).amount_attempts, 3);
  assert.deepEqual(votingReadOptions({ min_digits: 1, max_digits: 1, digits_allowed: ["1", "2"] }, timing), { min_digits: 1, max_digits: 1, digits_allowed: ["1", "2"], sec_wait: 33, amount_attempts: 3 });

  // אפס חזרות לא שולח amount_attempts בכלל, כך שהשורה לימות המשיח זהה לקודמת.
  const none = { votingWaitSeconds: 20, adminWaitSeconds: 5, menuRepeats: 0 };
  for (const options of [menuReadOptions([1], none), continuousMenuInput(12, false, none).read, naturalMenuInput(12, false, none).read, adminReadOptions(none), menuReadOptions([1]), adminReadOptions()]) {
    assert.equal("amount_attempts" in options, false);
  }
  assert.deepEqual(withMenuRepeats({ a: 1 }, 0), { a: 1 });
  assert.deepEqual(withMenuRepeats({ a: 1 }, 5), { a: 1, amount_attempts: 6 });
});

// ---------- השמירה בזיכרון בשירות הקו ----------

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("line settings are cached for a minute and then reloaded", async () => {
  const time = clock();
  let calls = 0;
  let site = { votingWaitSeconds: 30 };
  const loader = createLineSettingsLoader({ fetchSettings: async () => { calls++; return site; }, env: {}, now: time.now });
  assert.equal((await loader.get()).votingWaitSeconds, 30);
  site = { votingWaitSeconds: 45 };
  time.advance(59_000);
  assert.equal((await loader.get()).votingWaitSeconds, 30, "בתוך הדקה נשאר הערך השמור");
  assert.equal(calls, 1);
  time.advance(1_000);
  assert.equal((await loader.get()).votingWaitSeconds, 45, "אחרי דקה נטען מחדש");
  assert.equal(calls, 2);
});

test("an unreachable site keeps the last values, and falls back to env when there are none", async () => {
  const time = clock();
  let fail = true;
  let calls = 0;
  const env = { IVR_SEC_WAIT: "25", POST_VOTE_TRANSFER: "0771234567" };
  const loader = createLineSettingsLoader({ fetchSettings: async () => { calls++; if (fail) throw new Error("down"); return { votingWaitSeconds: 50, postVoteTransfer: "off" }; }, env, now: time.now });

  const first = await loader.get();
  assert.equal(first.votingWaitSeconds, 25, "בלי תשובה מהאתר — משתנה הסביבה");
  assert.equal(first.postVoteTransfer, "0771234567");
  await loader.get();
  assert.equal(calls, 1, "אחרי כישלון לא מנסים שוב מיד בכל שיחה");

  time.advance(15_000);
  fail = false;
  const loaded = await loader.get();
  assert.equal(loaded.votingWaitSeconds, 50);
  assert.equal(loaded.postVoteTransfer, "");

  fail = true;
  time.advance(61_000);
  const stale = await loader.get();
  assert.equal(stale.votingWaitSeconds, 50, "תקלה באתר אינה מחזירה לברירות המחדל");
  assert.equal(stale.postVoteTransfer, "");
});

test("calls that start together share one request", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = createLineSettingsLoader({ fetchSettings: async () => { calls++; await gate; return { menuRepeats: 2 }; }, env: {} });
  const pending = [loader.get(), loader.get(), loader.get()];
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  for (const result of results) assert.equal(result.menuRepeats, 2);
});

// ---------- הוורקר הבנוי מול SQLite ----------

function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async all() {
      const prepared = db.prepare(sql);
      try { return { results: prepared.all(...values), success: true }; }
      catch (error) {
        if (/no such table/i.test(error.message)) throw error;
        return { results: [], success: true, meta: prepared.run(...values) };
      }
    },
    async first(column) {
      const row = db.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] : row;
    },
    async run() { return this.all(); },
  });
  return { prepare: (sql) => statement(sql), async batch(statements) { return Promise.all(statements.map((item) => item.all())); } };
}

const media = { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [] }; } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function sessionCookie(db, email, token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, `sub-${token}`, email, "משתמש", null, Math.floor(Date.now() / 1000) + 3600);
  return `rosh_session=${token}`;
}

function newEnv() {
  const db = new DatabaseSync(":memory:");
  return { db, env: { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", IVR_SECRET: "line-secret", ASSETS: { fetch: async () => new Response("", { status: 404 }) } } };
}

const PATH = "http://localhost/api/admin/ivr-line-settings";
const IVR_PATH = "http://localhost/api/ivr/line-settings";
const post = (cookie, body) => new Request(PATH, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

test("the phone service gets empty settings before anything was saved, even on a fresh database", async () => {
  const worker = await loadWorker();
  const { env } = newEnv();
  // בלי בניית סכמה: נתיב הקו אינו מריץ אותה, והטבלה עדיין לא קיימת.
  const response = await worker.fetch(new Request(IVR_PATH, { headers: { "x-ivr-secret": "line-secret" } }), env, ctx);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).settings, { postVoteTransfer: "", votingWaitSeconds: null, adminWaitSeconds: null, menuRepeats: null });
});

test("only site managers can read or change the line settings, and the line needs its secret", async () => {
  const worker = await loadWorker();
  const { db, env } = newEnv();
  await worker.fetch(new Request("http://localhost/api/admin/overview"), env, ctx);
  const visitor = await sessionCookie(db, "someone@example.com", "visitor-token");
  const admin = await sessionCookie(db, "admin@example.com", "admin-token");

  for (const cookie of [undefined, visitor]) {
    const read = await worker.fetch(new Request(PATH, { headers: cookie ? { cookie } : {} }), env, ctx);
    assert.equal(read.status, 403);
    const write = await worker.fetch(post(cookie, { menuRepeats: 2 }), env, ctx);
    assert.equal(write.status, 403);
    assert.match((await write.json()).error, HEBREW);
  }
  assert.equal(db.prepare("SELECT value FROM ivr_store_meta WHERE key='line-settings'").get(), undefined, "בקשה בלי הרשאה לא שמרה דבר");

  for (const headers of [{}, { "x-ivr-secret": "wrong" }]) {
    const response = await worker.fetch(new Request(IVR_PATH, { headers }), env, ctx);
    assert.equal(response.status, 401);
  }

  const initial = await worker.fetch(new Request(PATH, { headers: { cookie: admin } }), env, ctx);
  assert.equal(initial.status, 200);
  const view = await initial.json();
  assert.deepEqual(view.effective, { postVoteTransfer: "0796077075", transferEnabled: true, votingWaitSeconds: 20, adminWaitSeconds: 5, menuRepeats: 0 });
  assert.equal(view.sources.votingWaitSeconds, "default");
});

test("a manager saves the settings and the phone service reads them", async () => {
  const worker = await loadWorker();
  const { db, env } = newEnv();
  await worker.fetch(new Request("http://localhost/api/admin/overview"), env, ctx);
  const admin = await sessionCookie(db, "admin@example.com", "admin-token");

  const saved = await worker.fetch(post(admin, { postVoteTransfer: "off", transferNumber: "0501234567", votingWaitSeconds: 30, adminWaitSeconds: 4, menuRepeats: 2 }), env, ctx);
  assert.equal(saved.status, 200, await saved.clone().text());
  const view = await saved.json();
  assert.equal(view.settings.postVoteTransfer, "off");
  assert.equal(view.settings.transferNumber, "0501234567");
  assert.equal(view.effective.transferEnabled, false);
  assert.equal(view.sources.menuRepeats, "admin");
  assert.equal(view.updatedBy, "admin@example.com");

  const line = await worker.fetch(new Request(IVR_PATH, { headers: { "x-ivr-secret": "line-secret" } }), env, ctx);
  assert.equal(line.status, 200);
  const { settings } = await line.json();
  assert.deepEqual(settings, { postVoteTransfer: "off", votingWaitSeconds: 30, adminWaitSeconds: 4, menuRepeats: 2 });
  // מה שהשירות מקבל מתורגם לערכים בפועל בשיחה.
  assert.deepEqual(resolveLineSettings(settings, { POST_VOTE_TRANSFER: "0771234567" }), { postVoteTransfer: "", votingWaitSeconds: 30, adminWaitSeconds: 4, menuRepeats: 2, sources: { postVoteTransfer: "site", votingWaitSeconds: "site", adminWaitSeconds: "site", menuRepeats: "site" } });

  const invalid = await worker.fetch(post(admin, { postVoteTransfer: "+972501234567", menuRepeats: 1 }), env, ctx);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /מספר ההעברה/);
  for (const body of [{ votingWaitSeconds: 3 }, { adminWaitSeconds: 60 }, { menuRepeats: 6 }, { menuRepeats: 1.5 }]) {
    const response = await worker.fetch(post(admin, body), env, ctx);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, HEBREW);
  }
  const broken = await worker.fetch(new Request(PATH, { method: "POST", headers: { "content-type": "application/json", cookie: admin }, body: "{" }), env, ctx);
  assert.equal(broken.status, 400);
  const after = await (await worker.fetch(new Request(IVR_PATH, { headers: { "x-ivr-secret": "line-secret" } }), env, ctx)).json();
  assert.deepEqual(after.settings, settings, "בקשה פסולה לא שינתה דבר");

  const reset = await worker.fetch(post(admin, { postVoteTransfer: "", votingWaitSeconds: null, adminWaitSeconds: null, menuRepeats: null }), env, ctx);
  assert.equal(reset.status, 200);
  const cleared = await (await worker.fetch(new Request(IVR_PATH, { headers: { "x-ivr-secret": "line-secret" } }), env, ctx)).json();
  assert.deepEqual(cleared.settings, { postVoteTransfer: "", votingWaitSeconds: null, adminWaitSeconds: null, menuRepeats: null }, "ריקון מחזיר את הקו לברירות המחדל שלו");
});
