/**
 * Optional Redis adapter state for Socket.IO rooms/pubsub across hub replicas.
 * Exposed via GET /metrics.
 */

import {
  createRedisCommandLatencyHistogram,
  type RedisCommandLatencyHistogramSnapshot,
} from "./redis_command_latency_histogram";

const connectLatencyHistogram = createRedisCommandLatencyHistogram();

export const observeSocketIoRedisAdapterConnectLatency = (durationMs: number): void => {
  connectLatencyHistogram.observe(durationMs);
};

let redisUrlConfigured: 0 | 1 = 0;
let redisAdapterActive: 0 | 1 = 0;
let connectionEventsTotal = 0;
let fallbackEventsTotal = 0;
let runtimeErrorEventsTotal = 0;
let lastConnectionAtMs = 0;
let lastFallbackAtMs = 0;
let attachedServersTotal = 0;

export const noteSocketIoRedisAdapterSkippedEmptyUrl = (): void => {
  redisUrlConfigured = 0;
  redisAdapterActive = 0;
};

export const noteSocketIoRedisAdapterConnected = (): void => {
  redisUrlConfigured = 1;
  redisAdapterActive = 1;
  connectionEventsTotal += 1;
  lastConnectionAtMs = Date.now();
};

export const noteSocketIoRedisAdapterFallback = (): void => {
  redisUrlConfigured = 1;
  redisAdapterActive = 0;
  fallbackEventsTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteSocketIoRedisAdapterRuntimeError = (): void => {
  runtimeErrorEventsTotal += 1;
  redisAdapterActive = 0;
};

export const noteSocketIoRedisAdapterDisconnected = (): void => {
  redisAdapterActive = 0;
};

export const noteSocketIoRedisAdapterAttachedServer = (): void => {
  attachedServersTotal += 1;
};

export const getSocketIoRedisAdapterMetricsSnapshot = (): {
  readonly redisUrlConfigured: 0 | 1;
  readonly redisAdapterActive: 0 | 1;
  readonly connectionEventsTotal: number;
  readonly fallbackEventsTotal: number;
  readonly runtimeErrorEventsTotal: number;
  readonly lastConnectionAtMs: number;
  readonly lastFallbackAtMs: number;
  readonly attachedServersTotal: number;
  readonly connectLatency: RedisCommandLatencyHistogramSnapshot;
} => ({
  redisUrlConfigured,
  redisAdapterActive,
  connectionEventsTotal,
  fallbackEventsTotal,
  runtimeErrorEventsTotal,
  lastConnectionAtMs,
  lastFallbackAtMs,
  attachedServersTotal,
  connectLatency: connectLatencyHistogram.snapshot(),
});

export const resetSocketIoRedisAdapterMetricsForTests = (): void => {
  redisUrlConfigured = 0;
  redisAdapterActive = 0;
  connectionEventsTotal = 0;
  fallbackEventsTotal = 0;
  runtimeErrorEventsTotal = 0;
  lastConnectionAtMs = 0;
  lastFallbackAtMs = 0;
  attachedServersTotal = 0;
  connectLatencyHistogram.reset();
};
