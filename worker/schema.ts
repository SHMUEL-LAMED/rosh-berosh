type SchemaEnv = { DB: D1Database };

/**
 * Production schema changes are applied only through the checked-in D1 migration.
 * Request handling must never create, alter, or drop production database objects.
 */
export function ensureRuntimeSchema(_env: SchemaEnv): Promise<void> {
  return Promise.resolve();
}
