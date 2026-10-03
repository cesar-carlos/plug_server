import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "test";
process.env.CONTAINER_PERSISTENCE_MODE = "prisma";
process.env.REST_GLOBAL_RATE_LIMIT_MAX = "0";
process.env.REST_SOCKET_EVENT_RATE_LIMIT_MAX = "0";
process.env.SOCKET_AGENT_PROTOCOL_READY_GRACE_MS = "0";
process.env.SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT = "0";

export default defineConfig({
  test: {
    include: ["tests/performance/rest_api_bench.test.ts"],
    environment: "node",
    pool: "forks",
    execArgv: ["--expose-gc"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
