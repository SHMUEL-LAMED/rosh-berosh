import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { normalizePhone as normalizeWorkerPhone } from "../worker/phone.js";
import { ballotRateConfig, checkBallotRate } from "../worker/rate-limit.js";
import { resolveCatalogPosition } from "../worker/catalog-position.js";
import { hasStageChoices } from "../app/voting-stage.js";

const require = createRequire(import.meta.url);
const { normalizePhone: normalizeIvrPhone, phone } = require("../ivr-service/src/phone.js");
const { continuousMenuInput, menuCode, menuReadOptions } = require("../ivr-service/src/menu-input.js");
const { sanitizeProgress, progressChanged } = require("../ivr-service/src/progress.js");

function ivrRecorderEnv(initial = []) {
  const recorders = new Set();
  const meta = new Map();
  const legacy = [...initial];
  const prepare = (sql) => {
    const make = (args = []) => ({
      _sql: sql,
      _args: args,
      bind(...next) { return make(next); },
      async all() {
        if (sql.includes("PRAGMA table_info(songs)")) return { results: [{ name: "cover_url" }] };
        if (sql.includes("PRAGMA table_info(ballots)")) return { results: [{ name: "fingerprint" }] };
        if (sql.includes("SELECT phone FROM ivr_recorders ORDER BY")) return { results: [...recorders].sort().map((phone) => ({ phone })) };
        return { results: [] };
      },
      async first() {
        if (sql.includes("SELECT value FROM ivr_store_meta")) return meta.has(args[0]) ? { value: meta.get(args[0]) } : null;
        if (sql.includes("DELETE FROM ivr_recorders") && sql.includes("RETURNING")) {
          if (recorders.has(args[0]) && recorders.size > 1) { recorders.delete(args[0]); return { phone: args[0] }; }
          return null;
        }
        if (sql.includes("SELECT phone FROM ivr_recorders WHERE")) return recorders.has(args[0]) ? { phone: args[0] } : null;
        return null;
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO ivr_recorders")) recorders.add(args[0]);
        if (sql.includes("INSERT OR REPLACE INTO ivr_store_meta")) meta.set(args[0], args[1]);
        return { success: true };
      },
    });
    return make();
  };
  const DB = {
    prepare,
    async exec() {},
    async batch(statements) { for (const statement of statements) await statement.run(); return statements.map(() => ({ results: [] })); },
  };
  const MEDIA = {
    async get(key) { return key === "ivr-prompts/recorders.json" ? { async json() { return legacy; } } : null; },
  };
  return { DB, MEDIA, recorders: () => [...recorders].sort() };
}

const phoneCases = [
  ["0501234567", "0501234567"],
  ["501234567", "0501234567"],
  ["972501234567", "0501234567"],
  ["+972-50-123-4567", "0501234567"],
  ["00972-50-123-4567", "0501234567"],
  ["02-1234567", "021234567"],
  ["unknown", ""],
  ["private", ""],
  ["", ""],
];

test("phone numbers are canonical in both the Worker and IVR service", () => {
  for (const [input, expected] of phoneCases) {
    assert.equal(normalizeWorkerPhone(input), expected, `Worker: ${input}`);
    assert.equal(normalizeIvrPhone(input), expected, `IVR: ${input}`);
  }
});

test("renaming a song preserves its existing position", () => {
  assert.equal(resolveCatalogPosition(undefined, 17, 40), 17);
  assert.equal(resolveCatalogPosition("", 17, 40), 17);
  assert.equal(resolveCatalogPosition("3", 17, 40), 3);
  assert.equal(resolveCatalogPosition(undefined, undefined, 40), 40);
});

test("an artists-only survey can advance without albums", () => {
  const catalog = { albums: [], songs: [], artists: [{ id: "artist-1" }] };
  assert.equal(hasStageChoices("artists", catalog, 0), true);
  assert.equal(hasStageChoices("albums", catalog, 0), false);
  assert.equal(hasStageChoices("summary", catalog, 0), true);
});

test("the IVR never falls back to a call id when caller id is missing", () => {
  assert.equal(phone({ callId: "shared-call-id" }), "");
  assert.equal(phone({ ApiPhone: "972501234567", callId: "ignored" }), "0501234567");
});

test("all long IVR menus use fixed-width codes without pages", () => {
  assert.equal(menuReadOptions([0, 1, 9]).max_digits, 1);
  const fiftyItems = continuousMenuInput(50, true);
  assert.equal(fiftyItems.width, 2);
  assert.equal(fiftyItems.finishCode, "00");
  assert.equal(fiftyItems.read.min_digits, 2);
  assert.equal(fiftyItems.read.max_digits, 2);
  assert.equal(fiftyItems.read.digits_allowed[0], "00");
  assert.equal(fiftyItems.read.digits_allowed[1], "01");
  assert.equal(fiftyItems.read.digits_allowed.at(-1), "50");
  assert.equal(menuCode(9, 2), "10");
  const systemPrompts = continuousMenuInput(15, true);
  assert.equal(systemPrompts.finishCode, "00");
  assert.deepEqual(systemPrompts.read.digits_allowed.slice(0, 3), ["00", "01", "02"]);
  assert.equal(systemPrompts.read.digits_allowed.at(-1), "15");
  assert.equal(systemPrompts.read.digits_allowed.includes("9"), false);
});

test("ballot rate limiting is persisted through D1", async () => {
  const buckets = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(bucket, resetAt, now) {
          return {
            async run() {
              if (sql.includes("DELETE FROM ballot_rate_limits")) {
                for (const [key, current] of buckets) if (current.resetAt < bucket) buckets.delete(key);
              }
            },
            async first() {
              const current = buckets.get(bucket);
              const next = !current || current.resetAt <= now
                ? { count: 1, resetAt }
                : { count: current.count + 1, resetAt: current.resetAt };
              buckets.set(bucket, next);
              return { count: next.count };
            },
          };
        },
      };
    },
  };

  for (let index = 0; index < ballotRateConfig.limit; index++) {
    assert.equal(await checkBallotRate(db, "203.0.113.7", 1_000), true);
  }
  assert.equal(await checkBallotRate(db, "203.0.113.7", 1_000), false);
  assert.equal(await checkBallotRate(db, "203.0.113.8", 1_000), true);
  assert.equal(await checkBallotRate(db, "203.0.113.7", 1_000 + ballotRateConfig.window), true);
});

test("phone ballot flow canonicalizes the voter before the unique check", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("ballot-flow-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const voters = new Set();

  const statement = (sql) => ({
    bind() { return statement(sql); },
    async first() {
      if (sql.includes("PRAGMA table_info")) return null;
      if (sql.includes("SELECT id FROM surveys")) return { id: "survey-1" };
      if (sql.includes("SELECT voting_open AS votingOpen")) return {
        votingOpen: 1,
        albumsEnabled: 1, albumsMin: 1, albumsMax: 1,
        songsEnabled: 1, songsMin: 1, songsMax: 1,
        artistsEnabled: 1, artistsMin: 1, artistsMax: 1,
      };
      return null;
    },
    async all() {
      if (sql.includes("PRAGMA table_info(songs)")) return { results: [{ name: "cover_url" }] };
      if (sql.includes("PRAGMA table_info(ballots)")) return { results: [{ name: "fingerprint" }] };
      if (sql.includes("COUNT(*) AS total FROM songs")) return { results: [{ albumId: "album-1", total: 1 }] };
      if (sql.includes("SELECT id FROM albums")) return { results: [{ id: "album-1" }] };
      if (sql.includes("SELECT id FROM artists")) return { results: [{ id: "artist-1" }] };
      if (sql.includes("SELECT s.id")) return { results: [{ id: "song-1", albumId: "album-1" }] };
      return { results: [] };
    },
  });

  const env = {
    IVR_SECRET: "test-secret",
    MEDIA: { async get(key) { return key === "settings/admin-emails.json" ? { async json() { return []; } } : null; } },
    DB: {
      prepare(sql) { return statement(sql); },
      async exec() {},
      async batch(statements) {
        const ballot = statements.find((item) => item && typeof item === "object" && "bind" in item);
        void ballot;
        const first = statements[0];
        const voterKey = first?.bind ? undefined : undefined;
        // The bound values live in the closure returned by statement; expose
        // them through a tiny inspection hook only for the ballot insert.
        const extract = first?._args;
        void voterKey;
        void extract;
        return [];
      },
    },
  };

  // Wrap statement so batch can inspect the SQL and bound ballot voter.
  env.DB.prepare = (sql) => {
    const make = (args = []) => ({
      _sql: sql,
      _args: args,
      bind(...nextArgs) { return make(nextArgs); },
      async first() { return statement(sql).first(); },
      async all() { return statement(sql).all(); },
      async run() { return { success: true }; },
    });
    return make();
  };
  env.DB.batch = async (statements) => {
    const ballot = statements.find((item) => item._sql?.includes("INSERT INTO ballots"));
    if (ballot) {
      const voterKey = ballot._args[2];
      if (voters.has(voterKey)) throw new Error("UNIQUE constraint failed: ballots.survey_id, ballots.voter_key");
      voters.add(voterKey);
    }
    return [];
  };

  const submit = (voterKey) => worker.fetch(new Request("http://localhost/api/ballots", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ivr-secret": "test-secret" },
    body: JSON.stringify({
      channel: "phone", voterKey,
      albumIds: ["album-1"],
      songIdsByAlbum: { "album-1": ["song-1"] },
      artistIds: ["artist-1"],
    }),
  }), env, { waitUntil() {}, passThroughOnException() {} });

  assert.equal((await submit("972501234567")).status, 201);
  assert.equal((await submit("0501234567")).status, 409);
  assert.deepEqual([...voters], ["0501234567"]);
});

test("private IVR configuration is never served as public media", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("security-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const requested = [];
  const env = {
    MEDIA: {
      async get(key) {
        requested.push(key);
        return {
          body: "audio",
          httpEtag: "test-etag",
          size: 5,
          writeHttpMetadata(headers) { headers.set("content-type", "audio/wav"); },
        };
      },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  for (const key of ["config.json", "recorders.json", "nested/private.json"]) {
    const response = await worker.fetch(new Request(`http://localhost/media/ivr-prompts/${key}`), env, ctx);
    assert.equal(response.status, 404, key);
  }
  assert.deepEqual(requested, []);

  const audio = await worker.fetch(new Request("http://localhost/media/ivr-prompts/system-main-test.wav"), env, ctx);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
});

test("an IVR object with a fake audio extension is still private", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("content-type-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/media/ivr-prompts/secret.wav"),
    {
      MEDIA: {
        async get() {
          return {
            body: '{"secret":true}',
            httpEtag: "test-etag",
            size: 15,
            writeHttpMetadata(headers) { headers.set("content-type", "application/json"); },
          };
        },
      },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 404);
});

test("phone administration requires both the IVR secret and an authorized caller", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("phone-admin-security-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const store = ivrRecorderEnv(["0501111111"]);
  const env = { IVR_SECRET: "phone-admin-secret", ...store };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const request = (phone, headers = {}) => new Request("http://localhost/api/ivr/admin/action", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ phone, action: "add-recorder", targetPhone: "972502222222" }),
  });

  assert.equal((await worker.fetch(request("0501111111"), env, ctx)).status, 401);
  assert.equal((await worker.fetch(request("0509999999", { "x-ivr-secret": "phone-admin-secret" }), env, ctx)).status, 403);

  const added = await worker.fetch(request("0501111111", { "x-ivr-secret": "phone-admin-secret" }), env, ctx);
  assert.equal(added.status, 200);
  assert.deepEqual(store.recorders(), ["0501111111", "0502222222"]);
});

test("phone administration never removes the last authorized recorder", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("last-recorder-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const store = ivrRecorderEnv(["0501111111"]);
  const env = { IVR_SECRET: "phone-admin-secret", ...store };
  const response = await worker.fetch(new Request("http://localhost/api/ivr/admin/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ivr-secret": "phone-admin-secret" },
    body: JSON.stringify({ phone: "0501111111", action: "remove-recorder", targetPhone: "0501111111" }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /אי אפשר להסיר/);
  assert.deepEqual(store.recorders(), ["0501111111"]);
});

test("stale phone progress is filtered against the current catalog and quotas", () => {
  const catalog = {
    albums: [{ id: "a1" }, { id: "a2" }],
    songs: [{ id: "s1", albumId: "a1" }, { id: "s2", albumId: "a1" }, { id: "s3", albumId: "a2" }],
    artists: [{ id: "r1" }, { id: "r2" }],
  };
  const rules = { albumsEnabled: 1, albumsMax: 1, songsEnabled: 1, songsMax: 1, artistsEnabled: 1, artistsMax: 1 };
  const saved = { albumIds: ["deleted", "a1", "a2"], songIdsByAlbum: { deleted: ["ghost"], a1: ["gone", "s2", "s1"], a2: ["s3"] }, artistIds: ["gone", "r2", "r1"] };
  const sanitized = sanitizeProgress(saved, catalog, rules);
  assert.deepEqual(sanitized, { albumIds: ["a1"], songIdsByAlbum: { a1: ["s2"] }, artistIds: ["r2"] });
  assert.equal(progressChanged(saved, sanitized), true);
  assert.equal(progressChanged(sanitized, sanitized), false);
});

test("two recorder additions do not overwrite each other", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("recorder-concurrency-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const store = ivrRecorderEnv(["0501111111"]);
  const env = { IVR_SECRET: "phone-admin-secret", ...store };
  const add = (targetPhone) => worker.fetch(new Request("http://localhost/api/ivr/admin/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ivr-secret": "phone-admin-secret" },
    body: JSON.stringify({ phone: "0501111111", action: "add-recorder", targetPhone }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const responses = await Promise.all([add("0502222222"), add("0503333333")]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(store.recorders(), ["0501111111", "0502222222", "0503333333"]);
});

test("prompt upload rechecks recorder authorization", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("revoked-recorder-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const store = ivrRecorderEnv(["0501111111"]);
  const form = new FormData();
  form.set("phone", "0509999999");
  form.set("key", "system:main_menu");
  form.set("label", "תפריט ראשי");
  form.set("file", new File(["audio"], "prompt.wav", { type: "audio/wav" }));
  const response = await worker.fetch(new Request("http://localhost/api/ivr/prompt", {
    method: "POST", headers: { "x-ivr-secret": "phone-admin-secret" }, body: form,
  }), { IVR_SECRET: "phone-admin-secret", ...store }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 403);
});
