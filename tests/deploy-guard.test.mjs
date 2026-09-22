import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * חיבור ה-Git של Cloudflare (Workers Builds) מריץ את פקודת הפריסה על כל ענף
 * שנדחף, וענף שהתבסס על main ישן דרס פעם את הפרודקשן. לכן תחת Workers Builds
 * רק main בונה את "rosh-berosh"; כל ענף אחר בונה וורקר תצוגה מקדימה נפרד.
 */

const PRODUCTION_BRANCH = "main";

test("under Workers Builds only main builds the production Worker", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /const PRODUCTION_BRANCH = "main"/);
  assert.match(config, /!!process\.env\.WORKERS_CI && process\.env\.WORKERS_CI_BRANCH !== PRODUCTION_BRANCH/);
  assert.match(config, /isPreviewBuild \? "rosh-berosh-preview" : "rosh-berosh"/);
  assert.match(config, /name: workerName,/);
});

test("the built Wrangler config carries the name the build environment calls for", () => {
  const built = new URL("../dist/server/wrangler.json", import.meta.url);
  if (!existsSync(built)) return; // `npm run build` has not run in this checkout
  const { name } = JSON.parse(readFileSync(built, "utf8"));
  const preview = !!process.env.WORKERS_CI && process.env.WORKERS_CI_BRANCH !== PRODUCTION_BRANCH;
  assert.equal(name, preview ? "rosh-berosh-preview" : "rosh-berosh");
});
