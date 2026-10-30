import { defineConfig } from "vitest/config";

// Explicit harness: no application bootstrap, Prisma cleanup or checkout .env.
// Each test owns its Socket.IO listener, child processes and temporary journal.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/unused_recovery_test",
      CONTAINER_PERSISTENCE_MODE: "memory",
    },
    environment: "node",
    include: [
      "tests/integration/sql_operation_dart_transport.integration.test.ts",
      "tests/integration/sql_operation_dart_recovery.integration.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 90000,
  },
});
