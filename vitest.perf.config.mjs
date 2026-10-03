import { defineConfig } from "vitest/config";

// The benchmark measures the bridge, not database-backed audit persistence.
process.env.SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT = "0";

export default defineConfig({
  test: {
    setupFiles: ["tests/performance/setup.ts"],
    globals: true,
    environment: "node",
    root: ".",
    include: ["tests/performance/**/*.test.ts"],
    exclude: ["node_modules", "dist", "tests/performance/rest_api_bench.test.ts",
      ...(process.env.SOCKET_COLUMNAR_BENCH_DISABLED === "true" ? ["tests/performance/socket_columnar_bench.test.ts"] : [])],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
