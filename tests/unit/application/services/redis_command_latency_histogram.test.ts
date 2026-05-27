import { describe, expect, it } from "vitest";

import {
  REDIS_COMMAND_LATENCY_BUCKETS_MS,
  createRedisCommandLatencyHistogram,
} from "../../../../src/application/services/redis_command_latency_histogram";

describe("redis_command_latency_histogram", () => {
  it("starts empty (count=0, all quantiles=0)", () => {
    const histogram = createRedisCommandLatencyHistogram();
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(0);
    expect(snapshot.sumMs).toBe(0);
    expect(snapshot.p50Ms).toBe(0);
    expect(snapshot.p95Ms).toBe(0);
    expect(snapshot.p99Ms).toBe(0);
    for (const bucket of snapshot.buckets) {
      expect(bucket.count).toBe(0);
    }
  });

  it("computes monotonic quantiles p50 <= p95 <= p99 from a representative distribution", () => {
    const histogram = createRedisCommandLatencyHistogram();
    // Simulate a typical Redis latency distribution (skewed, mostly fast).
    for (let i = 0; i < 100; i += 1) {
      histogram.observe(0.5 + (i % 10) * 0.05); // ~0.5-1ms cluster
    }
    for (let i = 0; i < 30; i += 1) {
      histogram.observe(20 + i); // 20-49ms cluster
    }
    for (let i = 0; i < 5; i += 1) {
      histogram.observe(800 + i * 10); // 800-840ms outliers
    }
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(135);
    expect(snapshot.p50Ms).toBeLessThanOrEqual(snapshot.p95Ms);
    expect(snapshot.p95Ms).toBeLessThanOrEqual(snapshot.p99Ms);
    // p50 should land in the fast cluster (≤ ~5 ms with linear interpolation).
    expect(snapshot.p50Ms).toBeLessThanOrEqual(5);
    // p95 should reflect the outliers cluster (≥ 50 ms typically; the
    // interpolation can land anywhere in [50, 250] depending on bucket
    // boundaries — assert a permissive lower bound).
    expect(snapshot.p95Ms).toBeGreaterThan(20);
  });

  it("counts a single observation in the smallest applicable bucket and all larger ones (cumulative)", () => {
    const histogram = createRedisCommandLatencyHistogram();
    histogram.observe(3);
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(1);
    expect(snapshot.sumMs).toBe(3);
    expect(snapshot.buckets[0]).toMatchObject({ le: "1", count: 0 });
    expect(snapshot.buckets[1]).toMatchObject({ le: "2", count: 0 });
    expect(snapshot.buckets[2]).toMatchObject({ le: "5", count: 1 });
    expect(snapshot.buckets[3]).toMatchObject({ le: "10", count: 1 });
    expect(snapshot.buckets[snapshot.buckets.length - 1]?.count).toBe(1);
  });

  it("ignores invalid observations (negative, NaN)", () => {
    const histogram = createRedisCommandLatencyHistogram();
    histogram.observe(-1);
    histogram.observe(Number.NaN);
    histogram.observe(Number.POSITIVE_INFINITY);
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(0);
    expect(snapshot.sumMs).toBe(0);
  });

  it("observations larger than the largest bucket still bump count and sum (Inf bucket via count - bucket sum)", () => {
    const histogram = createRedisCommandLatencyHistogram();
    histogram.observe(10_000);
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(1);
    expect(snapshot.sumMs).toBe(10_000);
    for (const bucket of snapshot.buckets) {
      expect(bucket.count).toBe(0);
    }
  });

  it("reset clears state", () => {
    const histogram = createRedisCommandLatencyHistogram();
    histogram.observe(50);
    histogram.observe(500);
    histogram.reset();
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(0);
    expect(snapshot.sumMs).toBe(0);
  });

  it("buckets are sorted in ascending order and start at 1ms", () => {
    expect(REDIS_COMMAND_LATENCY_BUCKETS_MS[0]).toBe(1);
    for (let i = 1; i < REDIS_COMMAND_LATENCY_BUCKETS_MS.length; i += 1) {
      expect(REDIS_COMMAND_LATENCY_BUCKETS_MS[i]).toBeGreaterThan(
        REDIS_COMMAND_LATENCY_BUCKETS_MS[i - 1] ?? 0,
      );
    }
  });

  it("binary search lands on the correct bucket for every boundary value", () => {
    /**
     * Parity check: for every defined bucket boundary `b`, an observation
     * exactly at `b` must populate the same-index bucket and every larger
     * bucket (cumulative monotonicity), but no smaller bucket.
     */
    for (let bucketIdx = 0; bucketIdx < REDIS_COMMAND_LATENCY_BUCKETS_MS.length; bucketIdx += 1) {
      const histogram = createRedisCommandLatencyHistogram();
      const value = REDIS_COMMAND_LATENCY_BUCKETS_MS[bucketIdx] ?? 0;
      histogram.observe(value);
      const snapshot = histogram.snapshot();
      for (let i = 0; i < snapshot.buckets.length; i += 1) {
        const expected = i >= bucketIdx ? 1 : 0;
        expect(snapshot.buckets[i]?.count).toBe(expected);
      }
    }
  });

  it("binary search lands on the correct bucket for values just above each boundary", () => {
    /**
     * `b + epsilon` must move the observation to the NEXT bucket. For the
     * last bucket, `b + epsilon` falls into the implicit `+Inf` bucket.
     */
    const epsilon = 0.001;
    for (let bucketIdx = 0; bucketIdx < REDIS_COMMAND_LATENCY_BUCKETS_MS.length; bucketIdx += 1) {
      const histogram = createRedisCommandLatencyHistogram();
      const boundary = REDIS_COMMAND_LATENCY_BUCKETS_MS[bucketIdx] ?? 0;
      histogram.observe(boundary + epsilon);
      const snapshot = histogram.snapshot();
      const isLastBucket = bucketIdx === REDIS_COMMAND_LATENCY_BUCKETS_MS.length - 1;
      for (let i = 0; i < snapshot.buckets.length; i += 1) {
        const expected = !isLastBucket && i >= bucketIdx + 1 ? 1 : 0;
        expect(snapshot.buckets[i]?.count).toBe(expected);
      }
      if (isLastBucket) {
        expect(snapshot.count).toBe(1); // counted, but no bucket
      }
    }
  });

  it("binary search parity: random sample of 1000 values matches a linear scan reference", () => {
    /**
     * Reference implementation (linear scan) — used here only as a test
     * oracle. Asserting bucket counts match across both implementations
     * proves the binary-search refactor is behavior-preserving.
     */
    const linearScanCounts = new Array<number>(REDIS_COMMAND_LATENCY_BUCKETS_MS.length).fill(0);
    const histogram = createRedisCommandLatencyHistogram();
    for (let i = 0; i < 1_000; i += 1) {
      const value = Math.random() * 6_000; // span across [0, +Inf bucket)
      histogram.observe(value);
      for (let b = 0; b < REDIS_COMMAND_LATENCY_BUCKETS_MS.length; b += 1) {
        if (value <= (REDIS_COMMAND_LATENCY_BUCKETS_MS[b] ?? 0)) {
          linearScanCounts[b] = (linearScanCounts[b] ?? 0) + 1;
          break;
        }
      }
    }
    const snapshot = histogram.snapshot();
    let cumulative = 0;
    for (let i = 0; i < REDIS_COMMAND_LATENCY_BUCKETS_MS.length; i += 1) {
      cumulative += linearScanCounts[i] ?? 0;
      expect(snapshot.buckets[i]?.count).toBe(cumulative);
    }
  });
});
