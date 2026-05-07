import { describe, expect, it } from "vitest";

import {
  getRestRateLimitRedisMetricsSnapshot,
  noteRestRateLimitRedisConnected,
  noteRestRateLimitRedisFallback,
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
  });

  it("tracks fallback count when URL was set but connection failed", () => {
    resetRestRateLimitRedisMetricsForTests();
    noteRestRateLimitRedisFallback();
    const s = getRestRateLimitRedisMetricsSnapshot();
    expect(s.redisUrlConfigured).toBe(1);
    expect(s.redisStoreActive).toBe(0);
    expect(s.fallbackEventsTotal).toBe(1);
  });
});
