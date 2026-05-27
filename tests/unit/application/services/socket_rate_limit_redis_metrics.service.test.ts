import { afterEach, describe, expect, it } from "vitest";

import {
  getSocketRateLimitRedisMetricsSnapshot,
  noteSocketRateLimitRedisAtomicRollback,
  noteSocketRateLimitRedisCircuitOpened,
  noteSocketRateLimitRedisConnected,
  noteSocketRateLimitRedisDecision,
  noteSocketRateLimitRedisFallback,
  noteSocketRateLimitRedisTrackedKey,
  resetSocketRateLimitRedisMetricsForTests,
} from "../../../../src/application/services/socket_rate_limit_redis_metrics.service";

describe("socket_rate_limit_redis_metrics", () => {
  afterEach(() => {
    resetSocketRateLimitRedisMetricsForTests();
  });

  it("tracks connected/fallback/circuit transitions", () => {
    noteSocketRateLimitRedisConnected();
    noteSocketRateLimitRedisFallback();
    noteSocketRateLimitRedisCircuitOpened();
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(0);
    expect(s.fallbackEventsTotal).toBe(1);
    expect(s.circuitOpen).toBe(1);
    expect(s.circuitOpenedTotal).toBe(1);
  });

  it("counts allowed and rejected decisions separately", () => {
    noteSocketRateLimitRedisDecision(true);
    noteSocketRateLimitRedisDecision(true);
    noteSocketRateLimitRedisDecision(false);
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.redisAllowedTotal).toBe(2);
    expect(s.redisRejectedTotal).toBe(1);
  });

  it("tracked keys: monotonic counter increments on every observation", () => {
    for (let i = 0; i < 25; i += 1) {
      noteSocketRateLimitRedisTrackedKey(`plug_socket_rl:scope:user:${i}`);
    }
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.trackedKeysSeenTotal).toBe(25);
    expect(s.trackedKeysWindowSize).toBe(25);
  });

  it("tracked keys: window size never exceeds the configured cap (5000)", () => {
    for (let i = 0; i < 6_000; i += 1) {
      noteSocketRateLimitRedisTrackedKey(`plug_socket_rl:scope:user:${i}`);
    }
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.trackedKeysSeenTotal).toBe(6_000);
    expect(s.trackedKeysWindowSize).toBeLessThanOrEqual(5_000);
    expect(s.trackedKeysWindowSize).toBeGreaterThan(0);
  });

  it("tracked keys: re-observing a key keeps the window stable in size", () => {
    for (let pass = 0; pass < 3; pass += 1) {
      for (let i = 0; i < 100; i += 1) {
        noteSocketRateLimitRedisTrackedKey(`plug_socket_rl:scope:user:${i}`);
      }
    }
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.trackedKeysSeenTotal).toBe(300);
    expect(s.trackedKeysWindowSize).toBe(100);
  });

  it("counts atomic rollbacks (consume_or_rollback Lua deny path)", () => {
    noteSocketRateLimitRedisAtomicRollback();
    noteSocketRateLimitRedisAtomicRollback();
    noteSocketRateLimitRedisAtomicRollback();
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.atomicRollbacksTotal).toBe(3);
  });

  it("reset clears window and counters", () => {
    noteSocketRateLimitRedisTrackedKey("plug_socket_rl:scope:user:abc");
    resetSocketRateLimitRedisMetricsForTests();
    const s = getSocketRateLimitRedisMetricsSnapshot();
    expect(s.trackedKeysSeenTotal).toBe(0);
    expect(s.trackedKeysWindowSize).toBe(0);
  });
});
