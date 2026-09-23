import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  applyIvrRuntimeSchema,
  applyRuntimeSchema,
  columnStatement,
  RUNTIME_SCHEMA_COLUMNS,
  RUNTIME_SCHEMA_INDEXES,
  RUNTIME_SCHEMA_IVR_TABLES,
  RUNTIME_SCHEMA_SEEDS,
  RUNTIME_SCHEMA_TABLES,
} from "../worker/schema-statements.js";

const EXPECTED_TABLES = [
  "surveys", "albums", "songs", "artists", "ballots",
  "blocked_fingerprints",
  "album_votes", "song_votes", "artist_votes", "poll_settings",
  "ballot_rate_limits", "ivr_recorders", "ivr_prompts", "ivr_store_meta", "ivr_admin_audit",
  "auth_sessions", "site_ballot_progress", "media_uploads", "subscribers",
  "program_episodes", "program_settings", "program_events", "program_messages", "program_versions",
  "program_user_data", "program_likes", "program_push", "program_transcripts", "program_transcription_jobs",
  "program_comments", "program_moments",
];

function fakeDb({ existingColumns = {}, fail = () => false } = {}) {
  const executed = [];
  return {
    executed,
    async exec() { throw new Error("D1_EXEC_ERROR: exec splits on newlines and cannot run multi-line statements"); },
    prepare(sql) {
      return {
        async all() {
          const table = /PRAGMA table_info\((\w+)\)/.exec(sql)?.[1];
          return { results: table ? (existingColumns[table] ?? []).map((name) => ({ name })) : [] };
        },
        async run() {
          if (fail(sql)) throw new Error(`D1_ERROR: ${sql} failed`);
          executed.push(sql);
          return { success: true };
        },
      };
    },
  };
}

const created = (executed) => executed.flatMap((sql) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)?.[1] ?? []);

test("the runtime schema creates every table through prepared statements", async () => {
  const db = fakeDb();
  const failures = await applyRuntimeSchema(db);
  assert.deepEqual(failures, []);
  assert.deepEqual(created(db.executed), EXPECTED_TABLES);
  assert.equal(db.executed.filter((sql) => sql.startsWith("CREATE INDEX") || sql.startsWith("CREATE UNIQUE INDEX")).length, RUNTIME_SCHEMA_INDEXES.length);
  for (const seed of RUNTIME_SCHEMA_SEEDS) assert.ok(db.executed.includes(seed), seed);
});

test("every statement is a single statement, because prepare runs one at a time", () => {
  for (const statement of [...RUNTIME_SCHEMA_TABLES, ...RUNTIME_SCHEMA_INDEXES, ...RUNTIME_SCHEMA_SEEDS]) {
    assert.equal(statement.includes(";"), false, statement);
  }
});

test("the bootstrap covers every table the worker queries", () => {
  const sources = ["worker/index.ts", "worker/admin.ts", "worker/subscribers-admin.ts", "worker/ivr-admin.ts", "worker/ivr-prompts.ts", "worker/rate-limit.js", "worker/auth.ts", "worker/program-api.ts", "worker/program-tools.ts", "worker/program-push.ts", "worker/program-ai.ts"];
  const referenced = new Set();
  for (const file of sources) {
    const sql = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [, table] of sql.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/g)) referenced.add(table);
  }
  for (const table of referenced) {
    if (table === "excluded") continue;
    assert.ok(EXPECTED_TABLES.includes(table), `${table} is queried but never created at runtime`);
  }
});

test("a failing statement does not block the tables after it", async () => {
  const db = fakeDb({ fail: (sql) => sql.includes("album_votes") });
  const failures = await applyRuntimeSchema(db);
  assert.ok(failures.length >= 1);
  assert.ok(failures.every((failure) => failure.statement.includes("album_votes")));
  assert.ok(created(db.executed).includes("ivr_store_meta"));
});

test("missing columns are added only when the table lacks them", async () => {
  const full = Object.fromEntries(RUNTIME_SCHEMA_COLUMNS.map(({ table, column }) => [table, column]));
  const withColumns = fakeDb({
    existingColumns: Object.keys(full).reduce((all, table) => {
      all[table] = RUNTIME_SCHEMA_COLUMNS.filter((spec) => spec.table === table).map((spec) => spec.column);
      return all;
    }, {}),
  });
  await applyRuntimeSchema(withColumns);
  assert.equal(withColumns.executed.some((sql) => sql.startsWith("ALTER TABLE")), false);

  const withoutColumns = fakeDb();
  await applyRuntimeSchema(withoutColumns);
  assert.deepEqual(
    withoutColumns.executed.filter((sql) => sql.startsWith("ALTER TABLE")),
    RUNTIME_SCHEMA_COLUMNS.map(columnStatement),
  );
});

test("the statements run against SQLite from an empty database and stay idempotent", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return t.skip("node:sqlite is unavailable without --experimental-sqlite"); }

  const sqlite = new DatabaseSync(":memory:");
  const db = {
    prepare(sql) {
      const make = (args = []) => ({
        bind: (...next) => make(next),
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
      });
      return make();
    },
  };

  assert.deepEqual(await applyRuntimeSchema(db), []);
  assert.deepEqual(await applyRuntimeSchema(db), []);
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  for (const table of EXPECTED_TABLES) assert.ok(tables.includes(table), table);
  const survey = sqlite.prepare("SELECT id, active FROM surveys").all();
  assert.equal(survey.length, 1);
  assert.equal(survey[0].id, "main");
  assert.equal(survey[0].active, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM poll_settings").get().total, 1);
});

// D1 כמו בייצור: `batch` הוא טרנזקציה אחת — משפט שנכשל מבטל את כל הקבוצה
function batchingDb(options = {}) {
  const db = fakeDb(options);
  db.batches = 0;
  db.runs = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    const run = statement.run;
    return { ...statement, sql, run: () => { db.runs++; return run(); } };
  };
  db.batch = async (statements) => {
    db.batches++;
    if (statements.some((statement) => options.fail?.(statement.sql))) throw new Error(options.batchError || "D1_ERROR: UNIQUE constraint failed: SQLITE_CONSTRAINT");
    const results = [];
    for (const statement of statements) {
      if (statement.sql.startsWith("PRAGMA")) results.push(await statement.all());
      else { db.executed.push(statement.sql); results.push({ success: true, results: [] }); }
    }
    return results;
  };
  return db;
}

test("a cold worker builds the schema in three D1 round trips, not one per statement", async () => {
  const full = {};
  for (const { table, column } of RUNTIME_SCHEMA_COLUMNS) (full[table] ??= []).push(column);
  const db = batchingDb({ existingColumns: full });
  assert.deepEqual(await applyRuntimeSchema(db), []);
  assert.equal(db.batches, 3);
  assert.equal(db.runs, 0);
  assert.deepEqual(created(db.executed), EXPECTED_TABLES);
  assert.equal(db.executed.filter((sql) => sql.startsWith("CREATE INDEX") || sql.startsWith("CREATE UNIQUE INDEX")).length, RUNTIME_SCHEMA_INDEXES.length);
  for (const seed of RUNTIME_SCHEMA_SEEDS) assert.ok(db.executed.includes(seed), seed);
});

test("batched: only the missing columns are added", async () => {
  const db = batchingDb();
  assert.deepEqual(await applyRuntimeSchema(db), []);
  assert.deepEqual(db.executed.filter((sql) => sql.startsWith("ALTER TABLE")), RUNTIME_SCHEMA_COLUMNS.map(columnStatement));
});

test("batched: a failing statement rolls back its batch, and the rest still run one by one", async () => {
  const db = batchingDb({ fail: (sql) => sql.includes("album_votes") });
  const failures = await applyRuntimeSchema(db);
  assert.ok(failures.length >= 1);
  assert.ok(failures.every((failure) => failure.statement.includes("album_votes")));
  assert.ok(created(db.executed).includes("ivr_store_meta"));
  assert.ok(db.executed.includes("CREATE INDEX IF NOT EXISTS program_moments_episode_idx ON program_moments(episode_id)"));
});

test("batched: when the database itself is down, the whole schema costs three failed calls, not ninety", async () => {
  // מכסה שנגמרה / עומס / רשת: כל משפט ייכשל שוב; מריצים משפט־משפט רק על שגיאה של משפט
  const db = batchingDb({ fail: () => true, batchError: "D1_ERROR: Your account has exceeded D1's free tier daily row read limit" });
  const failures = await applyRuntimeSchema(db);
  assert.equal(db.batches, 3);
  assert.equal(db.runs, 0);
  assert.equal(failures.length, 3);
  assert.ok(failures.every((failure) => /daily row read limit/.test(failure.error.message)));
});

test("batched statements run against SQLite from an empty database and stay idempotent", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return t.skip("node:sqlite is unavailable without --experimental-sqlite"); }

  const sqlite = new DatabaseSync(":memory:");
  let batches = 0;
  const db = {
    prepare(sql) {
      return { sql, async all() { return { results: sqlite.prepare(sql).all() }; }, async run() { sqlite.prepare(sql).run(); return { success: true }; } };
    },
    async batch(statements) {
      batches++;
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => (/^\s*(PRAGMA|SELECT)/i.test(statement.sql)
          ? { results: sqlite.prepare(statement.sql).all() }
          : (sqlite.prepare(statement.sql).run(), { results: [] })));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };

  assert.deepEqual(await applyRuntimeSchema(db), []);
  assert.deepEqual(await applyRuntimeSchema(db), []);
  assert.equal(batches, 6);
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  for (const table of EXPECTED_TABLES) assert.ok(tables.includes(table), table);
  const columns = sqlite.prepare("PRAGMA table_info(program_transcripts)").all().map((row) => row.name);
  assert.ok(columns.includes("parts_json"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM surveys").get().total, 1);
});

test("the phone line builds only its own tables, so a call never waits for the whole schema", async () => {
  const db = fakeDb();
  const failures = await applyIvrRuntimeSchema(db);
  assert.deepEqual(failures, []);
  assert.deepEqual(created(db.executed), ["ivr_recorders", "ivr_prompts", "ivr_store_meta", "ivr_admin_audit"]);
  assert.equal(db.executed.length, RUNTIME_SCHEMA_IVR_TABLES.length);
  assert.ok(db.executed.length < RUNTIME_SCHEMA_TABLES.length);
});

test("the phone line routes do not run the full schema bootstrap on every request", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const ivrRoutes = worker.slice(worker.indexOf('/api/ivr/recorders/check'), worker.indexOf('/api/ballots'));
  assert.doesNotMatch(ivrRoutes, /ensureRuntimeSchema/);
  const readRules = worker.slice(worker.indexOf("async function readRules"), worker.indexOf("async function catalog"));
  assert.doesNotMatch(readRules, /ensureRuntimeSchema/, "reading voting rules must stay on the fast path");
});

test("a missing phone table is rebuilt and the read is retried, instead of failing the call", () => {
  const prompts = readFileSync(new URL("../worker/ivr-prompts.ts", import.meta.url), "utf8");
  assert.match(prompts, /no such table/);
  assert.match(prompts, /await ensureIvrSchema\(env\);\n\s*return run\(\);/);
  assert.match(prompts, /export async function readIvrRecorders[\s\S]*?withIvrTables/);
});
