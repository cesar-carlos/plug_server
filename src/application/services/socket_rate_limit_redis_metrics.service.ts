/**
 * Optional Redis backend state for Socket rate limits. Exposed via GET /metrics.
 */

let redisUrlConfigured: 0 | 1 = 0;
let redisStoreActive: 0 | 1 = 0;
let fallbackEventsTotal = 0;
let runtimeCommandErrorEventsTotal = 0;
let connectionEventsTotal = 0;
let circuitOpen: 0 | 1 = 0;
let circuitOpenedTotal = 0;
let redisAllowedTotal = 0;
let redisRejectedTotal = 0;
let lastFallbackAtMs = 0;
let lastConnectionAtMs = 0;
const trackedRedisKeys = new Set<string>();

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

export const noteSocketRateLimitRedisTrackedKey = (key: string): void => {
  if (trackedRedisKeys.size >= 10_000 && !trackedRedisKeys.has(key)) {
    trackedRedisKeys.clear();
  }
  trackedRedisKeys.add(key);
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
  readonly trackedKeysApprox: number;
  readonly lastFallbackAtMs: number;
  readonly lastConnectionAtMs: number;
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
  trackedKeysApprox: trackedRedisKeys.size,
  lastFallbackAtMs,
  lastConnectionAtMs,
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
  trackedRedisKeys.clear();
  lastFallbackAtMs = 0;
  lastConnectionAtMs = 0;
};
