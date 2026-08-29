import assert from "node:assert/strict";
import test from "node:test";
import { applyRuntimeSchema, RUNTIME_SCHEMA_COLUMNS, RUNTIME_SCHEMA_INDEXES, RUNTIME_SCHEMA_TABLES } from "../worker/schema-statements.js";

function fakeDb({ existingColumns = { songs: ["cover_url"], ballots: ["fingerprint"] }, fail = () => false } = {}) {
  const executed = [];
  return {
    executed,
    async exec() { throw new Error("D1_EXEC_ERROR: exec splits on newlines and cannot run multi-line statements"); },
    prepare(sql) {
      return {
        async all() {
          const table = /PRAGMA table_info\((\w+)\)/.exec(sql)?.[1];
          if (table) return { results: (existingColumns[table] ?? []).map((name) => ({ name })) };
          return { results: [] };
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
  for (const table of ["ballot_rate_limits", "ivr_recorders", "ivr_prompts", "ivr_store_meta", "ivr_admin_audit"]) {
    assert.ok(created(db.executed).includes(table), `${table} was not created`);
  }
  assert.equal(db.executed.filter((sql) => sql.startsWith("CREATE INDEX")).length, RUNTIME_SCHEMA_INDEXES.length);
});

test("every statement is a single statement, because prepare runs one at a time", () => {
  for (const statement of [...RUNTIME_SCHEMA_TABLES, ...RUNTIME_SCHEMA_INDEXES]) {
    assert.equal(statement.includes(";"), false, statement);
  }
});

test("a failing statement does not block the tables after it", async () => {
  const db = fakeDb({ fail: (sql) => sql.includes("album_votes") });
  const failures = await applyRuntimeSchema(db);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].statement.includes("album_votes"));
  assert.ok(created(db.executed).includes("ivr_store_meta"));
});

test("a missing table for the first statement still leaves the IVR store created", async () => {
  const db = fakeDb({ fail: (sql) => sql.includes("ballot_rate_limits") });
  const failures = await applyRuntimeSchema(db);
  assert.equal(failures.length, 2);
  assert.ok(created(db.executed).includes("ivr_store_meta"));
});

test("missing columns are added only when the table lacks them", async () => {
  const withColumns = fakeDb();
  await applyRuntimeSchema(withColumns);
  assert.equal(withColumns.executed.some((sql) => sql.startsWith("ALTER TABLE")), false);

  const withoutColumns = fakeDb({ existingColumns: { songs: [], ballots: [] } });
  await applyRuntimeSchema(withoutColumns);
  assert.deepEqual(
    withoutColumns.executed.filter((sql) => sql.startsWith("ALTER TABLE")),
    RUNTIME_SCHEMA_COLUMNS.map(({ table, column, type }) => `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`),
  );
});
