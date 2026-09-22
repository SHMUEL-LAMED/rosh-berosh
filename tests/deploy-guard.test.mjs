import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * חיבור ה-Git של Cloudflare (Workers Builds) מריץ את פקודת הפריסה על כל ענף
 * שנדחף, וענף שהתבסס על main ישן דרס פעם את הפרודקשן. הוא גם כופה את שם
 * הוורקר, ולכן אי אפשר להפנות ענף לוורקר אחר. תחת Workers Builds רק main
 * נבנה בכלל; כל ענף אחר נכשל בטעינת vite.config.ts, לפני כל פריסה.
 */

test("under Workers Builds any branch but main fails before it can deploy", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /const PRODUCTION_BRANCH = "main"/);
  assert.match(config, /process\.env\.WORKERS_CI &&\s*process\.env\.WORKERS_CI_BRANCH !== PRODUCTION_BRANCH &&\s*!process\.env\.WORKERS_BUILDS_ALLOW_BRANCHES/);
  assert.match(config, /throw new Error\(\s*`Workers Builds: branch/);
  assert.doesNotMatch(config, /rosh-berosh-preview/, "a preview Worker name is not a guard: Workers Builds overrides the name");
});

test("the built Wrangler config always names the production Worker", () => {
  const built = new URL("../dist/server/wrangler.json", import.meta.url);
  if (!existsSync(built)) return; // `npm run build` has not run in this checkout
  assert.equal(JSON.parse(readFileSync(built, "utf8")).name, "rosh-berosh");
});
