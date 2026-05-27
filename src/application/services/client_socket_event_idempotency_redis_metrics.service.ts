/**
 * Optional Redis state for distributed idempotency of `client:custom.*` publishes.
 * Exposed via GET /metrics.
 */

import {
  createRedisCommandLatencyHistogram,
  type RedisCommandLatencyHistogramSnapshot,
} from "./redis_command_latency_histogram";

export type ClientSocketEventIdempotencyRedisLatencyOp =
  | "get"
  | "set"
  | "lock"
  | "unlock"
  | "extend";

const latencyHistograms: Record<
  ClientSocketEventIdempotencyRedisLatencyOp,
  ReturnType<typeof createRedisCommandLatencyHistogram>
> = {
  get: createRedisCommandLatencyHistogram(),
  set: createRedisCommandLatencyHistogram(),
  lock: createRedisCommandLatencyHistogram(),
  unlock: createRedisCommandLatencyHistogram(),
  extend: createRedisCommandLatencyHistogram(),
};

export const observeClientSocketEventIdempotencyRedisLatency = (
  op: ClientSocketEventIdempotencyRedisLatencyOp,
  durationMs: number,
): void => {
  latencyHistograms[op].observe(durationMs);
};

let redisUrlConfigured: 0 | 1 = 0;
let redisStoreActive: 0 | 1 = 0;
let connectionEventsTotal = 0;
let fallbackEventsTotal = 0;
let runtimeCommandErrorEventsTotal = 0;
let replayHitsTotal = 0;
let conflictsTotal = 0;
let locksAcquiredTotal = 0;
let lockExtensionsTotal = 0;
let lockContentionTotal = 0;
let lockWaitTimeoutsTotal = 0;
let writesTotal = 0;
let lastConnectionAtMs = 0;
let lastFallbackAtMs = 0;

export const noteClientSocketEventIdempotencyRedisSkippedEmptyUrl = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
};

export const noteClientSocketEventIdempotencyRedisConnected = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 1;
  connectionEventsTotal += 1;
  lastConnectionAtMs = Date.now();
};

export const noteClientSocketEventIdempotencyRedisFallback = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  fallbackEventsTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteClientSocketEventIdempotencyRedisDisconnected = (): void => {
  redisStoreActive = 0;
};

export const noteClientSocketEventIdempotencyRedisCommandError = (): void => {
  runtimeCommandErrorEventsTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisReplay = (): void => {
  replayHitsTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisConflict = (): void => {
  conflictsTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisLockAcquired = (): void => {
  locksAcquiredTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisLockExtended = (): void => {
  lockExtensionsTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisLockContention = (): void => {
  lockContentionTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisLockWaitTimeout = (): void => {
  lockWaitTimeoutsTotal += 1;
};

export const noteClientSocketEventIdempotencyRedisWrite = (): void => {
  writesTotal += 1;
};

export const getClientSocketEventIdempotencyRedisMetricsSnapshot = (): {
  readonly redisUrlConfigured: 0 | 1;
  readonly redisStoreActive: 0 | 1;
  readonly connectionEventsTotal: number;
  readonly fallbackEventsTotal: number;
  readonly runtimeCommandErrorEventsTotal: number;
  readonly replayHitsTotal: number;
  readonly conflictsTotal: number;
  readonly locksAcquiredTotal: number;
  readonly lockExtensionsTotal: number;
  readonly lockContentionTotal: number;
  readonly lockWaitTimeoutsTotal: number;
  readonly writesTotal: number;
  readonly lastConnectionAtMs: number;
  readonly lastFallbackAtMs: number;
  readonly latency: Record<
    ClientSocketEventIdempotencyRedisLatencyOp,
    RedisCommandLatencyHistogramSnapshot
  >;
} => ({
  redisUrlConfigured,
  redisStoreActive,
  connectionEventsTotal,
  fallbackEventsTotal,
  runtimeCommandErrorEventsTotal,
  replayHitsTotal,
  conflictsTotal,
  locksAcquiredTotal,
  lockExtensionsTotal,
  lockContentionTotal,
  lockWaitTimeoutsTotal,
  writesTotal,
  lastConnectionAtMs,
  lastFallbackAtMs,
  latency: {
    get: latencyHistograms.get.snapshot(),
    set: latencyHistograms.set.snapshot(),
    lock: latencyHistograms.lock.snapshot(),
    unlock: latencyHistograms.unlock.snapshot(),
    extend: latencyHistograms.extend.snapshot(),
  },
});

export const resetClientSocketEventIdempotencyRedisMetricsForTests = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  connectionEventsTotal = 0;
  fallbackEventsTotal = 0;
  runtimeCommandErrorEventsTotal = 0;
  replayHitsTotal = 0;
  conflictsTotal = 0;
  locksAcquiredTotal = 0;
  lockExtensionsTotal = 0;
  lockContentionTotal = 0;
  lockWaitTimeoutsTotal = 0;
  writesTotal = 0;
  lastConnectionAtMs = 0;
  lastFallbackAtMs = 0;
  latencyHistograms.get.reset();
  latencyHistograms.set.reset();
  latencyHistograms.lock.reset();
  latencyHistograms.unlock.reset();
  latencyHistograms.extend.reset();
};
