import { applyRuntimeSchema } from "./schema-statements.js";

type SchemaEnv = { DB: D1Database };

let migrated = false;

export async function ensureRuntimeSchema(env: SchemaEnv): Promise<void> {
  if (migrated) return;
  const failures = await applyRuntimeSchema(env.DB);
  for (const failure of failures) console.error("schema migration error", failure.statement, failure.error);
  migrated = failures.length === 0;
}
