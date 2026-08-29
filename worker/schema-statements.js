/** בניית הסכמה בזמן ריצה: משפט SQL אחד בכל פריט, מופעל דרך prepare ולא דרך exec. */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS ballot_rate_limits (
    bucket TEXT PRIMARY KEY NOT NULL,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ivr_recorders (
    phone TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS ivr_prompts (
    key TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    audio_url TEXT NOT NULL,
    yemot_path TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ivr_store_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ivr_admin_audit (
    id TEXT PRIMARY KEY NOT NULL,
    phone TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    status INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
];

const COLUMNS = [
  { table: "songs", column: "cover_url", type: "TEXT" },
  { table: "ballots", column: "fingerprint", type: "TEXT" },
];

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS ballots_survey_created_idx ON ballots(survey_id, created_at)",
  "CREATE INDEX IF NOT EXISTS ballots_fingerprint_idx ON ballots(fingerprint) WHERE fingerprint IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS album_votes_album_idx ON album_votes(album_id)",
  "CREATE INDEX IF NOT EXISTS song_votes_song_idx ON song_votes(song_id)",
  "CREATE INDEX IF NOT EXISTS artist_votes_artist_idx ON artist_votes(artist_id)",
  "CREATE INDEX IF NOT EXISTS ballot_rate_limits_reset_idx ON ballot_rate_limits(reset_at)",
  "CREATE INDEX IF NOT EXISTS ivr_admin_audit_created_idx ON ivr_admin_audit(created_at)",
];

export const RUNTIME_SCHEMA_TABLES = TABLES;
export const RUNTIME_SCHEMA_COLUMNS = COLUMNS;
export const RUNTIME_SCHEMA_INDEXES = INDEXES;

async function addMissingColumn(db, { table, column, type }) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (info.results.some((existing) => existing.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
}

/**
 * מריץ כל משפט בנפרד כדי שכשל אחד לא ימנע את יצירת שאר הטבלאות,
 * ומחזיר את רשימת המשפטים שנכשלו.
 */
export async function applyRuntimeSchema(db) {
  const failures = [];
  const step = async (name, run) => {
    try { await run(); }
    catch (error) { failures.push({ statement: name, error }); }
  };
  for (const statement of TABLES) await step(statement, () => db.prepare(statement).run());
  for (const column of COLUMNS) await step(`ALTER TABLE ${column.table} ADD COLUMN ${column.column}`, () => addMissingColumn(db, column));
  for (const statement of INDEXES) await step(statement, () => db.prepare(statement).run());
  return failures;
}
