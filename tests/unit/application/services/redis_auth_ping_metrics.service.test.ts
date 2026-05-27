import { afterEach, describe, expect, it } from "vitest";

import {
  getRedisAuthPingMetricsSnapshot,
  noteRedisAuthPing,
  resetRedisAuthPingMetricsForTests,
} from "../../../../src/application/services/redis_auth_ping_metrics.service";

describe("redis_auth_ping_metrics", () => {
  afterEach(() => {
    resetRedisAuthPingMetricsForTests();
  });

  it("starts empty", () => {
    expect(getRedisAuthPingMetricsSnapshot()).toEqual([]);
  });

  it("counts ok/auth_error/other_error per module independently", () => {
    noteRedisAuthPing("socket_rate_limit_redis", "ok");
    noteRedisAuthPing("socket_rate_limit_redis", "ok");
    noteRedisAuthPing("socket_rate_limit_redis", "auth_error");
    noteRedisAuthPing("rest_rate_limit_redis", "other_error");
    noteRedisAuthPing("rest_rate_limit_redis", "ok");

    const snapshot = getRedisAuthPingMetricsSnapshot();
    expect(snapshot).toContainEqual({
      module: "socket_rate_limit_redis",
      outcome: "ok",
      count: 2,
    });
    expect(snapshot).toContainEqual({
      module: "socket_rate_limit_redis",
      outcome: "auth_error",
      count: 1,
    });
    expect(snapshot).toContainEqual({
      module: "rest_rate_limit_redis",
      outcome: "ok",
      count: 1,
    });
    expect(snapshot).toContainEqual({
      module: "rest_rate_limit_redis",
      outcome: "other_error",
      count: 1,
    });
  });

  it("reset clears all entries", () => {
    noteRedisAuthPing("socket_io_redis_adapter", "ok");
    resetRedisAuthPingMetricsForTests();
    expect(getRedisAuthPingMetricsSnapshot()).toEqual([]);
  });
});
