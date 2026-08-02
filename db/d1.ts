import type { D1Database } from "@cloudflare/workers-types";

export async function getD1(): Promise<D1Database> {
  // Supplied by the Cloudflare/Vinext runtime rather than Node's module graph.
  // @ts-expect-error runtime virtual module
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB as D1Database;
}
