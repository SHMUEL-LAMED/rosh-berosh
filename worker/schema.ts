type SchemaEnv = { DB: D1Database };

let migrated = false;

export async function ensureRuntimeSchema(env: SchemaEnv): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    const songCols = await env.DB.prepare("PRAGMA table_info(songs)").all<{ name: string }>();
    if (!songCols.results.some((c) => c.name === "cover_url")) {
      await env.DB.exec("ALTER TABLE songs ADD COLUMN cover_url TEXT");
    }
    const ballotCols = await env.DB.prepare("PRAGMA table_info(ballots)").all<{ name: string }>();
    if (!ballotCols.results.some((c) => c.name === "fingerprint")) {
      await env.DB.exec("ALTER TABLE ballots ADD COLUMN fingerprint TEXT");
    }
  } catch { /* ignore if already exists */ }
}
