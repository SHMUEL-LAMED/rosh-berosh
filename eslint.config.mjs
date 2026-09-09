import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import globals from "globals";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // `worker/` is excluded from tsconfig, so TypeScript never reports a helper
  // that is used but never imported. Without this rule such a call builds
  // cleanly and only fails at runtime, as a ReferenceError inside the request.
  {
    files: ["worker/**/*.{ts,js}"],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        ...globals.es2025,
        // Ambient types from @cloudflare/workers-types. They exist only in type
        // positions, so add a name here when a new binding type is used.
        D1Database: "readonly",
        D1PreparedStatement: "readonly",
        D1Result: "readonly",
        Fetcher: "readonly",
        JsonWebKey: "readonly",
        R2Bucket: "readonly",
        R2Object: "readonly",
        R2ObjectBody: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "ivr-service/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
