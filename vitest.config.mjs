import { defineConfig } from "vitest/config";

const isCi = Boolean(process.env.CI);

export default defineConfig({
  test: {
    setupFiles: [
      "tests/setup/vitest.socket_snapshot_ttl.ts",
      "tests/setup/vitest.rate_limits.ts",
      "tests/setup/vitest.socket_consumer_roles.ts",
      "tests/setup/vitest.uploads_dir.ts",
    ],
    globals: true,
    environment: "node",
    root: ".",
    include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 45,
        functions: 35,
        branches: 55,
        statements: 45,
      },
    },
    // GitHub Actions runners are slower for Socket.IO + supertest bridge tests
    testTimeout: isCi ? 30_000 : 10_000,
    hookTimeout: isCi ? 60_000 : 10_000,
  },
});
