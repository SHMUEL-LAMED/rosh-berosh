type SchemaEnv = { DB: D1Database };

let migrated = false;

export async function ensureRuntimeSchema(env: SchemaEnv): Promise<void> {
  if (migrated) return;
  try {
    const songCols = await env.DB.prepare("PRAGMA table_info(songs)").all<{ name: string }>();
    if (!songCols.results.some((c) => c.name === "cover_url")) {
      await env.DB.exec("ALTER TABLE songs ADD COLUMN cover_url TEXT");
    }
    const ballotCols = await env.DB.prepare("PRAGMA table_info(ballots)").all<{ name: string }>();
    if (!ballotCols.results.some((c) => c.name === "fingerprint")) {
      await env.DB.exec("ALTER TABLE ballots ADD COLUMN fingerprint TEXT");
    }
    await env.DB.exec(`
      CREATE INDEX IF NOT EXISTS ballots_survey_created_idx ON ballots(survey_id, created_at);
      CREATE INDEX IF NOT EXISTS ballots_fingerprint_idx ON ballots(fingerprint) WHERE fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS album_votes_album_idx ON album_votes(album_id);
      CREATE INDEX IF NOT EXISTS song_votes_song_idx ON song_votes(song_id);
      CREATE INDEX IF NOT EXISTS artist_votes_artist_idx ON artist_votes(artist_id);
      CREATE TABLE IF NOT EXISTS ballot_rate_limits (
        bucket TEXT PRIMARY KEY NOT NULL,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ballot_rate_limits_reset_idx ON ballot_rate_limits(reset_at);
    `);
    migrated = true;
  } catch (error) {
    console.error("schema migration error", error);
  }
}
