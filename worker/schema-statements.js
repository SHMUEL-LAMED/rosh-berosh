/**
 * בניית הסכמה בזמן ריצה: משפט SQL אחד בכל פריט, מופעל דרך `prepare` ולא דרך
 * `exec` — D1 מפצל את הקלט של `exec()` לפי שורות ואינו יכול להריץ משפט הפרוס
 * על כמה שורות. המשפטים כאן מכסים את `drizzle/0000`–`drizzle/0010` והם
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
    voter_email TEXT,
    channel TEXT NOT NULL DEFAULT 'site',
    fingerprint TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at INTEGER,
    albums_done_at INTEGER,
    songs_done_at INTEGER,
    artists_done_at INTEGER,
    sessions INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS blocked_fingerprints (
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    blocked_by TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_sub TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS site_ballot_progress (
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    user_sub TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (survey_id, user_sub)
  )`,
  `CREATE TABLE IF NOT EXISTS media_uploads (
    id TEXT PRIMARY KEY NOT NULL,
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // רשימת התפוצה. הכתובת נשמרת תמיד באותיות קטנות, כדי שהאינדקס
  // הייחודי למטה ימנע כפילויות בלי צורך בהשוואה חסרת רישיות בשאילתה.
  `CREATE TABLE IF NOT EXISTS subscribers (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    source TEXT NOT NULL DEFAULT 'site',
    survey_id TEXT,
    user_sub TEXT,
    consented_at INTEGER NOT NULL DEFAULT (unixepoch()),
    unsubscribed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS program_episodes (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    number INTEGER,
    date TEXT,
    visible INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS program_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // אתר התוכניות: אירועי האזנה לסטטיסטיקה, הודעות מהמאזינים, וגרסאות
  // שנשמרות אוטומטית בכל פרסום של הקטלוג.
  `CREATE TABLE IF NOT EXISTS program_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    device TEXT,
    day TEXT NOT NULL,
    client_hash TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS program_messages (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    email TEXT,
    text TEXT NOT NULL,
    episode_id TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS program_versions (
    id TEXT PRIMARY KEY NOT NULL,
    by_email TEXT,
    note TEXT,
    episodes INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // אתר התוכניות: נתונים אישיים לכל חשבון (סנכרון בין מכשירים), לייקים,
  // מנויי התראות דחיפה, ותמלולים וסיכומים שנוצרים בבינה מלאכותית (למנהלים בלבד).
  `CREATE TABLE IF NOT EXISTS program_user_data (
    user_sub TEXT PRIMARY KEY,
    email TEXT,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS program_likes (
    user_sub TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_sub, episode_id)
  )`,
  `CREATE TABLE IF NOT EXISTS program_push (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_sub TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS program_transcripts (
    episode_id TEXT PRIMARY KEY,
    text TEXT NOT NULL DEFAULT '',
    parts_done INTEGER NOT NULL DEFAULT 0,
    parts_total INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // תגובות המאזינים לתוכניות: ממתינות לאישור מנהל, ויכולות להיות קשורות לרגע בתוכנית.
  `CREATE TABLE IF NOT EXISTS program_comments (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    user_sub TEXT,
    name TEXT,
    text TEXT NOT NULL,
    at_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    pinned INTEGER NOT NULL DEFAULT 0,
    reply TEXT,
    reply_by TEXT,
    replied_at INTEGER,
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
  { table: "ballots", column: "voter_email", definition: "TEXT" },
  { table: "ballots", column: "started_at", definition: "INTEGER" },
  { table: "ballots", column: "albums_done_at", definition: "INTEGER" },
  { table: "ballots", column: "songs_done_at", definition: "INTEGER" },
  { table: "ballots", column: "artists_done_at", definition: "INTEGER" },
  { table: "ballots", column: "sessions", definition: "INTEGER" },
  // אירועי האזנה: מיקום בתוכנית באחוזים, מקור ההגעה, והשעה בישראל
  { table: "program_events", column: "pct", definition: "INTEGER" },
  { table: "program_events", column: "ref", definition: "TEXT" },
  { table: "program_events", column: "hour", definition: "INTEGER" },
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
  "CREATE UNIQUE INDEX IF NOT EXISTS blocked_fingerprints_unique ON blocked_fingerprints(survey_id,fingerprint)",
  "CREATE INDEX IF NOT EXISTS album_votes_album_idx ON album_votes(album_id)",
  "CREATE INDEX IF NOT EXISTS song_votes_song_idx ON song_votes(song_id)",
  "CREATE INDEX IF NOT EXISTS artist_votes_artist_idx ON artist_votes(artist_id)",
  "CREATE INDEX IF NOT EXISTS ballot_rate_limits_reset_idx ON ballot_rate_limits(reset_at)",
  "CREATE INDEX IF NOT EXISTS ivr_admin_audit_created_idx ON ivr_admin_audit(created_at)",
  "CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at)",
  "CREATE INDEX IF NOT EXISTS site_ballot_progress_updated_idx ON site_ballot_progress(updated_at)",
  "CREATE INDEX IF NOT EXISTS media_uploads_created_idx ON media_uploads(created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS subscribers_email_unique ON subscribers(email)",
  "CREATE INDEX IF NOT EXISTS subscribers_created_idx ON subscribers(created_at)",
  // אינדקסים ללשונית הנתונים המתקדמים: פילוח לפי ערוץ, איתור מצביע חוזר
  // בין סקרים, ספירת הפתקים של מחשב חסום, וקישור נרשם לרשימה למצביע.
  "CREATE INDEX IF NOT EXISTS ballots_survey_channel_idx ON ballots(survey_id, created_at, channel)",
  "CREATE INDEX IF NOT EXISTS ballots_voter_key_idx ON ballots(voter_key)",
  "CREATE INDEX IF NOT EXISTS ballots_survey_fingerprint_idx ON ballots(survey_id, fingerprint)",
  "CREATE INDEX IF NOT EXISTS subscribers_user_sub_idx ON subscribers(user_sub)",
  "CREATE UNIQUE INDEX IF NOT EXISTS program_episodes_slug_unique ON program_episodes(slug)",
  "CREATE INDEX IF NOT EXISTS program_episodes_visible_date_idx ON program_episodes(visible,date,number)",
  "CREATE INDEX IF NOT EXISTS program_events_day_idx ON program_events(day,episode_id)",
  "CREATE INDEX IF NOT EXISTS program_events_created_idx ON program_events(created_at)",
  "CREATE INDEX IF NOT EXISTS program_messages_created_idx ON program_messages(created_at)",
  "CREATE INDEX IF NOT EXISTS program_versions_created_idx ON program_versions(created_at)",
  "CREATE INDEX IF NOT EXISTS program_likes_episode_idx ON program_likes(episode_id)",
  "CREATE INDEX IF NOT EXISTS program_comments_episode_idx ON program_comments(episode_id,status,created_at)",
];

const SEEDS = [
  "INSERT OR IGNORE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)",
  "INSERT OR IGNORE INTO poll_settings (id) VALUES ('main')",
];

export const RUNTIME_SCHEMA_TABLES = TABLES;
export const RUNTIME_SCHEMA_COLUMNS = COLUMNS;
export const RUNTIME_SCHEMA_INDEXES = INDEXES;
export const RUNTIME_SCHEMA_SEEDS = SEEDS;

// הטבלאות שקו הניהול הטלפוני נשען עליהן. בקשה מהקו לעולם אינה מריצה את כל
// בניית הסכמה — עשרות משפטים ברצף מאחרים את התשובה מעבר לזמן ההמתנה של ימות
// המשיח — ולכן אלה מורצים לבדם, ורק כשמתברר שטבלה חסרה.
export const RUNTIME_SCHEMA_IVR_TABLES = TABLES.filter((statement) => /CREATE TABLE IF NOT EXISTS ivr_/.test(statement));

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

/** בונה רק את טבלאות הקו הטלפוני, בלי שאר הסכמה. */
export async function applyIvrRuntimeSchema(db) {
  const failures = [];
  for (const statement of RUNTIME_SCHEMA_IVR_TABLES) {
    try { await db.prepare(statement).run(); }
    catch (error) { failures.push({ statement, error }); }
  }
  return failures;
}
