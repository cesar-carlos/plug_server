/**
 * Optional Redis backend state for REST HTTP rate limits (`express-rate-limit`).
 * Exposed via GET /metrics.
 */

import {
  createRedisCommandLatencyHistogram,
  type RedisCommandLatencyHistogramSnapshot,
} from "./redis_command_latency_histogram";

const latencyHistogram = createRedisCommandLatencyHistogram();

export const observeRestRateLimitRedisLatency = (durationMs: number): void => {
  latencyHistogram.observe(durationMs);
};

let redisUrlConfigured: 0 | 1 = 0;
let redisStoreActive: 0 | 1 = 0;
let fallbackEventsTotal = 0;
let runtimeCommandErrorEventsTotal = 0;
let connectionEventsTotal = 0;
let circuitOpen: 0 | 1 = 0;
let circuitOpenedTotal = 0;
let lastFallbackAtMs = 0;
let lastConnectionAtMs = 0;

export const noteRestRateLimitRedisSkippedEmptyUrl = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  circuitOpen = 0;
};

export const noteRestRateLimitRedisConnected = (): void => {
  const wasActive = redisStoreActive;
  redisUrlConfigured = 1;
  redisStoreActive = 1;
  circuitOpen = 0;
  if (wasActive === 0) {
    connectionEventsTotal += 1;
    lastConnectionAtMs = Date.now();
  }
};

export const noteRestRateLimitRedisRecovered = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 1;
  circuitOpen = 0;
};

export const noteRestRateLimitRedisFallback = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  fallbackEventsTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteRestRateLimitRedisCommandError = (): void => {
  runtimeCommandErrorEventsTotal += 1;
  noteRestRateLimitRedisFallback();
};

export const noteRestRateLimitRedisCircuitOpened = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  circuitOpen = 1;
  circuitOpenedTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteRestRateLimitRedisCircuitClosed = (): void => {
  circuitOpen = 0;
};

export const noteRestRateLimitRedisDisconnected = (): void => {
  redisStoreActive = 0;
  circuitOpen = 0;
};

export const getRestRateLimitRedisMetricsSnapshot = (): {
  readonly redisUrlConfigured: 0 | 1;
  readonly redisStoreActive: 0 | 1;
  readonly fallbackEventsTotal: number;
  readonly runtimeCommandErrorEventsTotal: number;
  readonly connectionEventsTotal: number;
  readonly circuitOpen: 0 | 1;
  readonly circuitOpenedTotal: number;
  readonly lastFallbackAtMs: number;
  readonly lastConnectionAtMs: number;
  readonly latency: RedisCommandLatencyHistogramSnapshot;
} => ({
  redisUrlConfigured,
  redisStoreActive,
  fallbackEventsTotal,
  runtimeCommandErrorEventsTotal,
  connectionEventsTotal,
  circuitOpen,
  circuitOpenedTotal,
  lastFallbackAtMs,
  lastConnectionAtMs,
  latency: latencyHistogram.snapshot(),
});

export const resetRestRateLimitRedisMetricsForTests = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  fallbackEventsTotal = 0;
  runtimeCommandErrorEventsTotal = 0;
  connectionEventsTotal = 0;
  circuitOpen = 0;
  circuitOpenedTotal = 0;
  lastFallbackAtMs = 0;
  lastConnectionAtMs = 0;
  latencyHistogram.reset();
};
