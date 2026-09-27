/**
 * Metrics for distributed agent hub presence and inter-replica bridge forward.
 * Exposed via GET /metrics when wired.
 */

import {
  createRedisCommandLatencyHistogram,
  type RedisCommandLatencyHistogramSnapshot,
} from "./redis_command_latency_histogram";

const latencyHistogram = createRedisCommandLatencyHistogram();

export const observeAgentHubPresenceRedisLatency = (durationMs: number): void => {
  latencyHistogram.observe(durationMs);
};

let presenceUrlConfigured: 0 | 1 = 0;
let presenceActive: 0 | 1 = 0;
let presenceFallbackEventsTotal = 0;
let bridgeForwardRequestsTotal = 0;
let bridgeForwardSuccessTotal = 0;
let bridgeForwardTimeoutTotal = 0;
let bridgeForwardErrorTotal = 0;
let bridgeCommandHandledTotal = 0;
let lastFallbackAtMs = 0;
let resolveRoutesIdsTotal = 0;
let resolveRoutesCallsTotal = 0;
let resolveRoutesFallbackTotal = 0;
const resolveRoutesLatencyHistogram = createRedisCommandLatencyHistogram();

export const noteAgentHubPresenceSkippedEmptyUrl = (): void => {
  presenceUrlConfigured = 0;
  presenceActive = 0;
};

export const noteAgentHubPresenceConnected = (): void => {
  presenceUrlConfigured = 1;
  presenceActive = 1;
};

export const noteAgentHubPresenceFallback = (): void => {
  presenceUrlConfigured = 1;
  presenceActive = 0;
  presenceFallbackEventsTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteAgentHubPresenceDisconnected = (): void => {
  presenceActive = 0;
};

export const noteBridgeForwardRequest = (): void => {
  bridgeForwardRequestsTotal += 1;
};

export const noteBridgeForwardSuccess = (): void => {
  bridgeForwardSuccessTotal += 1;
};

export const noteBridgeForwardTimeout = (): void => {
  bridgeForwardTimeoutTotal += 1;
};

export const noteBridgeForwardError = (): void => {
  bridgeForwardErrorTotal += 1;
};

export const noteAgentHubPresenceResolveRoutes = (idCount: number, durationMs: number): void => {
  resolveRoutesCallsTotal += 1;
  resolveRoutesIdsTotal += idCount;
  resolveRoutesLatencyHistogram.observe(durationMs);
};

export const noteAgentHubPresenceResolveRoutesFallback = (): void => {
  resolveRoutesFallbackTotal += 1;
};

export const noteBridgeCommandHandled = (): void => {
  bridgeCommandHandledTotal += 1;
};

export const getAgentHubPresenceRedisMetricsSnapshot = (): {
  readonly presenceUrlConfigured: 0 | 1;
  readonly presenceActive: 0 | 1;
  readonly presenceFallbackEventsTotal: number;
  readonly bridgeForwardRequestsTotal: number;
  readonly bridgeForwardSuccessTotal: number;
  readonly bridgeForwardTimeoutTotal: number;
  readonly bridgeForwardErrorTotal: number;
  readonly bridgeCommandHandledTotal: number;
  readonly lastFallbackAtMs: number;
  readonly resolveRoutesIdsTotal: number;
  readonly resolveRoutesCallsTotal: number;
  readonly resolveRoutesFallbackTotal: number;
  readonly commandLatency: RedisCommandLatencyHistogramSnapshot;
  readonly resolveRoutesLatency: RedisCommandLatencyHistogramSnapshot;
} => ({
  presenceUrlConfigured,
  presenceActive,
  presenceFallbackEventsTotal,
  bridgeForwardRequestsTotal,
  bridgeForwardSuccessTotal,
  bridgeForwardTimeoutTotal,
  bridgeForwardErrorTotal,
  bridgeCommandHandledTotal,
  lastFallbackAtMs,
  resolveRoutesIdsTotal,
  resolveRoutesCallsTotal,
  resolveRoutesFallbackTotal,
  commandLatency: latencyHistogram.snapshot(),
  resolveRoutesLatency: resolveRoutesLatencyHistogram.snapshot(),
});
