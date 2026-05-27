/**
 * Optional Redis backend state for Socket rate limits. Exposed via GET /metrics.
 */

import {
  createRedisCommandLatencyHistogram,
  type RedisCommandLatencyHistogramSnapshot,
} from "./redis_command_latency_histogram";

export type SocketRateLimitRedisLatencyOp = "consume" | "refund";

const latencyHistograms: Record<
  SocketRateLimitRedisLatencyOp,
  ReturnType<typeof createRedisCommandLatencyHistogram>
> = {
  consume: createRedisCommandLatencyHistogram(),
  refund: createRedisCommandLatencyHistogram(),
};

export const observeSocketRateLimitRedisLatency = (
  op: SocketRateLimitRedisLatencyOp,
  durationMs: number,
): void => {
  latencyHistograms[op].observe(durationMs);
};

let redisUrlConfigured: 0 | 1 = 0;
let redisStoreActive: 0 | 1 = 0;
let fallbackEventsTotal = 0;
let runtimeCommandErrorEventsTotal = 0;
let connectionEventsTotal = 0;
let circuitOpen: 0 | 1 = 0;
let circuitOpenedTotal = 0;
let redisAllowedTotal = 0;
let redisRejectedTotal = 0;
let windowResetsTotal = 0;
let saturationsTotal = 0;
/**
 * Number of in-script rollbacks performed by the Lua
 * `consume_or_rollback` script. Distinguishes the deny-path RTT-saving
 * rollback from the external `refundSocketRateLimitRedis` (post-validation
 * refund), which uses the legacy 2-RTT pattern. Sustained growth indicates
 * burst-shedding pressure on the rate limiter.
 */
let atomicRollbacksTotal = 0;
let lastFallbackAtMs = 0;
let lastConnectionAtMs = 0;
/**
 * Bounded sliding window of recently observed Redis keys.
 * The previous implementation used an unbounded `Set` cleared on overflow,
 * which caused a single GC spike clearing up to 10k strings (~800 KB).
 * `trackedKeysSeenTotal` is the monotonic counter exposed for cardinality
 * trending; `trackedRedisKeysWindow.size` is a gauge of currently active
 * keys within the last `TRACKED_KEYS_WINDOW_MS`.
 */
const TRACKED_KEYS_MAX = 5_000;
const TRACKED_KEYS_WINDOW_MS = 60_000;
const trackedRedisKeysWindow = new Map<string, number>();
let trackedKeysSeenTotal = 0;

export const noteSocketRateLimitRedisSkippedEmptyUrl = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  circuitOpen = 0;
};

export const noteSocketRateLimitRedisConnected = (): void => {
  const wasActive = redisStoreActive;
  redisUrlConfigured = 1;
  redisStoreActive = 1;
  circuitOpen = 0;
  if (wasActive === 0) {
    connectionEventsTotal += 1;
    lastConnectionAtMs = Date.now();
  }
};

export const noteSocketRateLimitRedisRecovered = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 1;
  circuitOpen = 0;
};

export const noteSocketRateLimitRedisFallback = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  fallbackEventsTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteSocketRateLimitRedisCommandError = (): void => {
  runtimeCommandErrorEventsTotal += 1;
  noteSocketRateLimitRedisFallback();
};

export const noteSocketRateLimitRedisCircuitOpened = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  circuitOpen = 1;
  circuitOpenedTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteSocketRateLimitRedisCircuitClosed = (): void => {
  circuitOpen = 0;
};

export const noteSocketRateLimitRedisDisconnected = (): void => {
  redisStoreActive = 0;
  circuitOpen = 0;
};

export const noteSocketRateLimitRedisDecision = (allowed: boolean): void => {
  if (allowed) {
    redisAllowedTotal += 1;
    return;
  }
  redisRejectedTotal += 1;
};

/**
 * Boundary-burst telemetry: incremented when a consume call observes
 * `usedRaw === cost`, indicating the key was just created (TTL is being set
 * for the first time in this window). Sustained high rate on a scope with
 * a long `windowMs` suggests rapid window churn — input for the
 * sliding-window spike re-validation (see docs/spikes/_README.md).
 */
export const noteSocketRateLimitRedisWindowReset = (): void => {
  windowResetsTotal += 1;
};

/**
 * Boundary-burst telemetry: incremented when a consume call lands exactly
 * at `used === max` (the request was the last allowed one in the window).
 * Combined with `windowResetsTotal` rate this surfaces "windows that
 * saturate then immediately reset" patterns where the boundary effect
 * matters in practice.
 */
export const noteSocketRateLimitRedisSaturation = (): void => {
  saturationsTotal += 1;
};

/**
 * Increments when `consume_or_rollback` Lua script returned `{0, used}` —
 * the request was rejected and rolled back inside the same round-trip.
 */
export const noteSocketRateLimitRedisAtomicRollback = (): void => {
  atomicRollbacksTotal += 1;
};

export const noteSocketRateLimitRedisTrackedKey = (key: string): void => {
  trackedKeysSeenTotal += 1;
  const now = Date.now();
  trackedRedisKeysWindow.set(key, now);
  if (trackedRedisKeysWindow.size <= TRACKED_KEYS_MAX) {
    return;
  }
  // Evict expired first; then drop oldest until under cap. Iteration order is insertion
  // order, but we re-set on every observation so the iterator yields the actual oldest.
  const cutoff = now - TRACKED_KEYS_WINDOW_MS;
  for (const [trackedKey, lastSeenMs] of trackedRedisKeysWindow) {
    if (lastSeenMs < cutoff) {
      trackedRedisKeysWindow.delete(trackedKey);
      if (trackedRedisKeysWindow.size <= TRACKED_KEYS_MAX) {
        return;
      }
    }
  }
  while (trackedRedisKeysWindow.size > TRACKED_KEYS_MAX) {
    const oldest = trackedRedisKeysWindow.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    trackedRedisKeysWindow.delete(oldest);
  }
};

export const getSocketRateLimitRedisMetricsSnapshot = (): {
  readonly redisUrlConfigured: 0 | 1;
  readonly redisStoreActive: 0 | 1;
  readonly fallbackEventsTotal: number;
  readonly runtimeCommandErrorEventsTotal: number;
  readonly connectionEventsTotal: number;
  readonly circuitOpen: 0 | 1;
  readonly circuitOpenedTotal: number;
  readonly redisAllowedTotal: number;
  readonly redisRejectedTotal: number;
  /** See `noteSocketRateLimitRedisWindowReset`. */
  readonly windowResetsTotal: number;
  /** See `noteSocketRateLimitRedisSaturation`. */
  readonly saturationsTotal: number;
  /** See `noteSocketRateLimitRedisAtomicRollback`. */
  readonly atomicRollbacksTotal: number;
  /** Active distinct keys observed within `TRACKED_KEYS_WINDOW_MS`. */
  readonly trackedKeysWindowSize: number;
  /** Monotonic counter of total `noteSocketRateLimitRedisTrackedKey` invocations. */
  readonly trackedKeysSeenTotal: number;
  readonly lastFallbackAtMs: number;
  readonly lastConnectionAtMs: number;
  readonly latency: Record<SocketRateLimitRedisLatencyOp, RedisCommandLatencyHistogramSnapshot>;
} => ({
  redisUrlConfigured,
  redisStoreActive,
  fallbackEventsTotal,
  runtimeCommandErrorEventsTotal,
  connectionEventsTotal,
  circuitOpen,
  circuitOpenedTotal,
  redisAllowedTotal,
  redisRejectedTotal,
  windowResetsTotal,
  saturationsTotal,
  atomicRollbacksTotal,
  trackedKeysWindowSize: trackedRedisKeysWindow.size,
  trackedKeysSeenTotal,
  lastFallbackAtMs,
  lastConnectionAtMs,
  latency: {
    consume: latencyHistograms.consume.snapshot(),
    refund: latencyHistograms.refund.snapshot(),
  },
});

export const resetSocketRateLimitRedisMetricsForTests = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  fallbackEventsTotal = 0;
  runtimeCommandErrorEventsTotal = 0;
  connectionEventsTotal = 0;
  circuitOpen = 0;
  circuitOpenedTotal = 0;
  redisAllowedTotal = 0;
  redisRejectedTotal = 0;
  windowResetsTotal = 0;
  saturationsTotal = 0;
  atomicRollbacksTotal = 0;
  trackedRedisKeysWindow.clear();
  trackedKeysSeenTotal = 0;
  lastFallbackAtMs = 0;
  lastConnectionAtMs = 0;
  latencyHistograms.consume.reset();
  latencyHistograms.refund.reset();
};
