/**
 * Shared latency histogram primitive for the four Redis-backed modules.
 * Buckets are expressed in milliseconds and follow the Prometheus convention
 * of monotonic upper-bounds (inclusive). The `+Inf` bucket is not stored
 * explicitly: counts above the largest bucket are reported via `count - sum
 * of bucket counts` at render time.
 */

export const REDIS_COMMAND_LATENCY_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000,
] as const;

export interface RedisCommandLatencyHistogramSnapshot {
  readonly buckets: readonly { readonly le: string; readonly count: number }[];
  readonly count: number;
  readonly sumMs: number;
  /**
   * Approximate latency quantiles derived via linear interpolation across
   * the `buckets` boundaries. Convenience for lightweight dashboards that
   * want explicit p50/p95/p99 without a Prometheus `histogram_quantile()`
   * round-trip. Returns `0` when no observations have been recorded.
   */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface RedisCommandLatencyHistogram {
  observe(durationMs: number): void;
  snapshot(): RedisCommandLatencyHistogramSnapshot;
  reset(): void;
}

/**
 * Binary search for the smallest bucket index `i` such that
 * `buckets[i] >= durationMs`. Returns `buckets.length` (i.e. `+Inf`)
 * when the observation is greater than every defined bucket. Buckets
 * are guaranteed sorted ascending, so this replaces the previous O(N)
 * linear scan with O(log N).
 *
 * Hot path: `recordObservation` is called for every Redis command. With
 * 11 buckets the linear scan averaged 5.5 comparisons; binary search
 * needs at most 4. For ~10⁵ commands/min the saving is small but free.
 */
const findBucketIndex = (buckets: readonly number[], durationMs: number): number => {
  let lo = 0;
  let hi = buckets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const boundary = buckets[mid] ?? 0;
    if (durationMs <= boundary) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
};

export const createRedisCommandLatencyHistogram = (): RedisCommandLatencyHistogram => {
  const buckets = REDIS_COMMAND_LATENCY_BUCKETS_MS;
  const counts = new Array<number>(buckets.length).fill(0);
  let sumMs = 0;
  let count = 0;

  return {
    observe(durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return;
      }
      sumMs += durationMs;
      count += 1;
      const idx = findBucketIndex(buckets, durationMs);
      if (idx < buckets.length) {
        counts[idx] = (counts[idx] ?? 0) + 1;
      }
      // idx === buckets.length means the observation falls in the +Inf
      // bucket; we don't store it explicitly (snapshot computes +Inf as
      // `count - sum(buckets)`).
    },
    snapshot(): RedisCommandLatencyHistogramSnapshot {
      // Cumulative counts as required by the Prometheus histogram contract.
      // Both arrays are pre-allocated to `buckets.length` to avoid the
      // realloc churn `Array.prototype.map` would cause when this snapshot
      // is hit on every metrics scrape.
      let cumulative = 0;
      const cumulativeCounts = new Array<number>(buckets.length);
      const rendered = new Array<{ readonly le: string; readonly count: number }>(buckets.length);
      for (let index = 0; index < buckets.length; index += 1) {
        cumulative += counts[index] ?? 0;
        cumulativeCounts[index] = cumulative;
        rendered[index] = { le: String(buckets[index]), count: cumulative };
      }
      const quantile = (q: number): number => {
        if (count === 0) {
          return 0;
        }
        const target = q * count;
        let prevBoundary = 0;
        let prevCount = 0;
        for (let i = 0; i < buckets.length; i += 1) {
          const upper = buckets[i] ?? 0;
          const cum = cumulativeCounts[i] ?? 0;
          if (cum >= target) {
            const inBucket = cum - prevCount;
            if (inBucket <= 0) {
              return upper;
            }
            const fraction = (target - prevCount) / inBucket;
            return prevBoundary + (upper - prevBoundary) * fraction;
          }
          prevBoundary = upper;
          prevCount = cum;
        }
        // All observations beyond the largest bucket: clamp to that boundary.
        return buckets[buckets.length - 1] ?? 0;
      };
      return {
        buckets: rendered,
        count,
        sumMs,
        p50Ms: quantile(0.5),
        p95Ms: quantile(0.95),
        p99Ms: quantile(0.99),
      };
    },
    reset(): void {
      for (let i = 0; i < counts.length; i += 1) {
        counts[i] = 0;
      }
      sumMs = 0;
      count = 0;
    },
  };
};
