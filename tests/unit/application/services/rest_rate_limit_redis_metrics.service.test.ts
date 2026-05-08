import { describe, expect, it } from "vitest";

import {
  getRestRateLimitRedisMetricsSnapshot,
  noteRestRateLimitRedisCircuitOpened,
  noteRestRateLimitRedisCommandError,
  noteRestRateLimitRedisConnected,
  noteRestRateLimitRedisDisconnected,
  noteRestRateLimitRedisFallback,
  noteRestRateLimitRedisRecovered,
  noteRestRateLimitRedisSkippedEmptyUrl,
  resetRestRateLimitRedisMetricsForTests,
} from "../../../../src/application/services/rest_rate_limit_redis_metrics.service";

describe("rest_rate_limit_redis_metrics", () => {
  it("tracks skipped empty URL", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisSkippedEmptyUrl();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(0);
    expect(s.redisStoreActive).toBe(0);
    expect(s.fallbackEventsTotal).toBe(0);
  });

  it("tracks connected state", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisConnected();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(1);
    expect(s.fallbackEventsTotal).toBe(0);
    expect(s.connectionEventsTotal).toBe(1);
  });

  it("tracks fallback count when URL was set but connection failed", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisFallback();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(0);
    expect(s.fallbackEventsTotal).toBe(1);
    expect(s.lastFallbackAtMs).toBeGreaterThan(0);
  });

  it("keeps URL configured when Redis disconnects after a successful connection", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisConnected();
    noteRestRateLimitRedisDisconnected();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(0);
    expect(s.fallbackEventsTotal).toBe(0);
  });

  it("can mark the store active again after a runtime fallback", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisConnected();
    noteRestRateLimitRedisFallback();
    noteRestRateLimitRedisRecovered();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(1);
    expect(s.fallbackEventsTotal).toBe(1);
    expect(s.connectionEventsTotal).toBe(1);
  });

  it("tracks runtime command errors separately from boot fallback", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisConnected();
    noteRestRateLimitRedisCommandError();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(0);
    expect(s.fallbackEventsTotal).toBe(1);
    expect(s.runtimeCommandErrorEventsTotal).toBe(1);
  });

  it("tracks Redis circuit open state", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisConnected();
    noteRestRateLimitRedisCircuitOpened();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.circuitOpen).toBe(1);
    expect(s.circuitOpenedTotal).toBe(1);
    expect(s.redisStoreActive).toBe(0);
  });
});
