/**
 * בניית הסכמה בזמן ריצה: משפט SQL אחד בכל פריט, מופעל דרך `prepare` ולא דרך
 * `exec` — D1 מפצל את הקלט של `exec()` לפי שורות ואינו יכול להריץ משפט הפרוס
 * על כמה שורות. המשפטים כאן מכסים את `drizzle/0000`–`drizzle/0006` והם
 * idempotent, כך שמסד קיים אינו משתנה ומסד ריק נבנה במלואו.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY NOT NULL,
    survey_id TEXT NOT NULL DEFAULT 'main' REFERENCES surveys(id),
    title TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    cover_url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY NOT NULL,
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    audio_url TEXT,
    cover_url TEXT,
    preview_start INTEGER NOT NULL DEFAULT 0,
    preview_end INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY NOT NULL,
    survey_id TEXT NOT NULL DEFAULT 'main' REFERENCES surveys(id),
    name TEXT NOT NULL,
    image_url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS ballots (
    id TEXT PRIMARY KEY NOT NULL,
    survey_id TEXT NOT NULL DEFAULT 'main' REFERENCES surveys(id),
    voter_key TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'site',
    fingerprint TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS album_votes (
    ballot_id TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
    album_id TEXT NOT NULL REFERENCES albums(id)
  )`,
  `CREATE TABLE IF NOT EXISTS song_votes (
    ballot_id TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
    album_id TEXT NOT NULL REFERENCES albums(id),
    song_id TEXT NOT NULL REFERENCES songs(id)
  )`,
  `CREATE TABLE IF NOT EXISTS artist_votes (
    ballot_id TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL REFERENCES artists(id)
  )`,
  `CREATE TABLE IF NOT EXISTS poll_settings (
    id TEXT PRIMARY KEY NOT NULL DEFAULT 'main',
    voting_open INTEGER NOT NULL DEFAULT 1,
    albums_enabled INTEGER NOT NULL DEFAULT 1,
    albums_min INTEGER NOT NULL DEFAULT 5,
    albums_max INTEGER NOT NULL DEFAULT 5,
    songs_enabled INTEGER NOT NULL DEFAULT 1,
    songs_min INTEGER NOT NULL DEFAULT 1,
    songs_max INTEGER NOT NULL DEFAULT 1,
    artists_enabled INTEGER NOT NULL DEFAULT 1,
    artists_min INTEGER NOT NULL DEFAULT 1,
    artists_max INTEGER NOT NULL DEFAULT 3
  )`,
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
  { table: "albums", column: "survey_id", definition: "TEXT NOT NULL DEFAULT 'main'" },
  { table: "artists", column: "survey_id", definition: "TEXT NOT NULL DEFAULT 'main'" },
  { table: "ballots", column: "survey_id", definition: "TEXT NOT NULL DEFAULT 'main'" },
  { table: "songs", column: "cover_url", definition: "TEXT" },
  { table: "songs", column: "preview_start", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "songs", column: "preview_end", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "ballots", column: "fingerprint", definition: "TEXT" },
];

// אינדקסים ייחודיים שהוחלפו ב-`drizzle/0001` ו-`drizzle/0002`.
const DROPPED_INDEXES = [
  "DROP INDEX IF EXISTS ballots_voter_unique",
  "DROP INDEX IF EXISTS song_votes_album_unique",
];

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS albums_survey_idx ON albums(survey_id)",
  "CREATE INDEX IF NOT EXISTS songs_album_idx ON songs(album_id)",
  "CREATE INDEX IF NOT EXISTS artists_survey_idx ON artists(survey_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ballots_voter_survey_unique ON ballots(survey_id, voter_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS album_votes_unique ON album_votes(ballot_id, album_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS song_votes_unique ON song_votes(ballot_id, album_id, song_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS artist_votes_unique ON artist_votes(ballot_id, artist_id)",
  "CREATE INDEX IF NOT EXISTS ballots_survey_created_idx ON ballots(survey_id, created_at)",
  "CREATE INDEX IF NOT EXISTS ballots_fingerprint_idx ON ballots(fingerprint) WHERE fingerprint IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS album_votes_album_idx ON album_votes(album_id)",
  "CREATE INDEX IF NOT EXISTS song_votes_song_idx ON song_votes(song_id)",
  "CREATE INDEX IF NOT EXISTS artist_votes_artist_idx ON artist_votes(artist_id)",
  "CREATE INDEX IF NOT EXISTS ballot_rate_limits_reset_idx ON ballot_rate_limits(reset_at)",
  "CREATE INDEX IF NOT EXISTS ivr_admin_audit_created_idx ON ivr_admin_audit(created_at)",
];

const SEEDS = [
  "INSERT OR IGNORE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)",
  "INSERT OR IGNORE INTO poll_settings (id) VALUES ('main')",
];

export const RUNTIME_SCHEMA_TABLES = TABLES;
export const RUNTIME_SCHEMA_COLUMNS = COLUMNS;
export const RUNTIME_SCHEMA_INDEXES = INDEXES;
export const RUNTIME_SCHEMA_SEEDS = SEEDS;

export function columnStatement({ table, column, definition }) {
  return `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`;
}

async function addMissingColumn(db, spec) {
  const info = await db.prepare(`PRAGMA table_info(${spec.table})`).all();
  if (info.results.some((existing) => existing.name === spec.column)) return;
  await db.prepare(columnStatement(spec)).run();
}

/**
 * מריץ כל משפט בנפרד כדי שכשל אחד לא ימנע את המשפטים שאחריו,
 * ומחזיר את רשימת המשפטים שנכשלו.
 */
export async function applyRuntimeSchema(db) {
  const failures = [];
  const step = async (statement, run) => {
    try { await run(); }
    catch (error) { failures.push({ statement, error }); }
  };
  for (const statement of TABLES) await step(statement, () => db.prepare(statement).run());
  for (const spec of COLUMNS) await step(columnStatement(spec), () => addMissingColumn(db, spec));
  for (const statement of [...DROPPED_INDEXES, ...INDEXES, ...SEEDS]) await step(statement, () => db.prepare(statement).run());
  return failures;
}
