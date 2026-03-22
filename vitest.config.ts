import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: ".",
    include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/**/*.d.ts"],
      // Increase thresholds incrementally as test coverage grows
      thresholds: {
        lines: 45,
        functions: 35,
        branches: 55,
        statements: 45,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
