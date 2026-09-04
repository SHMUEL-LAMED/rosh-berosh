import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  applyRuntimeSchema,
  columnStatement,
  RUNTIME_SCHEMA_COLUMNS,
  RUNTIME_SCHEMA_INDEXES,
  RUNTIME_SCHEMA_SEEDS,
  RUNTIME_SCHEMA_TABLES,
} from "../worker/schema-statements.js";

const EXPECTED_TABLES = [
  "surveys", "albums", "songs", "artists", "ballots",
  "album_votes", "song_votes", "artist_votes", "poll_settings",
  "ballot_rate_limits", "ivr_recorders", "ivr_prompts", "ivr_store_meta", "ivr_admin_audit",
  "auth_sessions", "site_ballot_progress", "media_uploads", "subscribers",
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
  const sources = ["worker/index.ts", "worker/admin.ts", "worker/subscribers-admin.ts", "worker/ivr-admin.ts", "worker/ivr-prompts.ts", "worker/rate-limit.js", "worker/auth.ts"];
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
