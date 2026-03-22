import { defineConfig } from "vitest/config";

/**
 * End-to-end tests: full HTTP server + Socket.IO (see tests/helpers/test_server.ts).
 * Invoked via `npm run test:e2e` only when `E2E_TESTS_ENABLED=true` in `.env` (scripts/run-e2e.cjs).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: ".",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /** One server + DB fixture at a time reduces load and avoids cross-file races on shared services. */
    fileParallelism: false,
    env: {
      E2E_SILENCE_LOGS: "true",
    },
  },
});
