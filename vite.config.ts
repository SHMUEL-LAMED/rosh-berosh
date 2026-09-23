import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// Cloudflare's Git integration (Workers Builds) runs the deploy command for
// every pushed branch, and a branch based on an older main once replaced the
// production Worker minutes after main had deployed. It also forces the
// Worker name (WRANGLER_CI_OVERRIDE_NAME), so a branch cannot be steered to a
// preview Worker from here. Under Workers Builds, therefore, only main may
// build at all: any other branch, or a build whose branch is unknown, fails
// here, before anything is deployed. Once the dashboard's non-production
// deploy command is `wrangler versions upload`, which never touches
// production, set WORKERS_BUILDS_ALLOW_BRANCHES=1 there to lift this.
// Locally and in the GitHub Action none of these variables is set.
const PRODUCTION_BRANCH = "main";
if (
  process.env.WORKERS_CI &&
  process.env.WORKERS_CI_BRANCH !== PRODUCTION_BRANCH &&
  !process.env.WORKERS_BUILDS_ALLOW_BRANCHES
) {
  throw new Error(
    `Workers Builds: branch "${process.env.WORKERS_CI_BRANCH ?? "?"}" is not built or deployed. ` +
      `Only "${PRODUCTION_BRANCH}" deploys the production Worker (the GitHub Action does that too). ` +
      "See README, section פריסה.",
  );
}

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: "c3ee6d34-3663-4876-baee-1867809e1d3d",
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "rosh-berosh-media",
        },
      ]
    : [],
  // Workers AI: תמלול וסיכום של תוכניות באתר התוכניות (צריך להיות מופעל בחשבון)
  ai: { binding: "AI" },
  // כל דקה: התראות דחיפה (מנה מהתור) על תוכניות מתוזמנות שהגיע מועד פרסומן, ותמלול אוטומטי
  triggers: { crons: ["* * * * *"] },
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
