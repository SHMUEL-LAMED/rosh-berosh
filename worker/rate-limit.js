const BALLOT_RATE_WINDOW = 60;
const BALLOT_RATE_LIMIT = 5;
let lastCleanupAt = 0;

async function rateBucket(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkBallotRate(db, ip, now = Math.floor(Date.now() / 1000)) {
  try {
    if (now - lastCleanupAt >= BALLOT_RATE_WINDOW) {
      await db.prepare("DELETE FROM ballot_rate_limits WHERE reset_at < ?").bind(now - BALLOT_RATE_WINDOW).run();
      lastCleanupAt = now;
    }
    const bucket = await rateBucket(ip);
    const resetAt = now + BALLOT_RATE_WINDOW;
    const row = await db.prepare(`
      INSERT INTO ballot_rate_limits (bucket, count, reset_at)
      VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET
        count = CASE WHEN ballot_rate_limits.reset_at <= ? THEN 1 ELSE ballot_rate_limits.count + 1 END,
        reset_at = CASE WHEN ballot_rate_limits.reset_at <= ? THEN excluded.reset_at ELSE ballot_rate_limits.reset_at END
      RETURNING count
    `).bind(bucket, resetAt, now, now).first();
    return Number(row?.count || 0) <= BALLOT_RATE_LIMIT;
  } catch (error) {
    console.error("ballot rate limit error", error);
    return false;
  }
}

export const ballotRateConfig = { limit: BALLOT_RATE_LIMIT, window: BALLOT_RATE_WINDOW };
