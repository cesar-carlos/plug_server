"use strict";

/**
 * Runs Vitest e2e suite only when E2E_TESTS_ENABLED=true (after loading .env).
 * Exit 0 when skipped so CI/scripts can call npm run test:e2e unconditionally.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });

if (process.env.E2E_TESTS_ENABLED !== "true") {
  console.log(
    "[test:e2e] Skipped: set E2E_TESTS_ENABLED=true in .env (see .env.example).",
  );
  process.exit(0);
}

const vitestCli = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestCli, "run", "-c", "vitest.e2e.config.ts"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
