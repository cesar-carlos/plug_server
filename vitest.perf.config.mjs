import { defineConfig } from "vitest/config";

// The benchmark measures the bridge, not database-backed audit persistence.
process.env.SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT = "0";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: ".",
    include: ["tests/performance/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
