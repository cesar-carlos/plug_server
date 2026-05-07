/**
 * Estado do backend Redis opcional para limites HTTP REST (`express-rate-limit`).
 * Exposto via GET /metrics.
 */

let redisUrlConfigured: 0 | 1 = 0;
let redisStoreActive: 0 | 1 = 0;
let fallbackEventsTotal = 0;

export const noteRestRateLimitRedisSkippedEmptyUrl = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
};

export const noteRestRateLimitRedisConnected = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 1;
};

/** Falha ao ligar com URL definida: conta fallback e mantém store em memória. */
export const noteRestRateLimitRedisFallback = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  fallbackEventsTotal += 1;
};

/** Graceful shutdown: deixa de haver store Redis ativo (URL configurada mantém-se para alertas). */
export const noteRestRateLimitRedisDisconnected = (): void => {
  redisStoreActive = 0;
};

export const getRestRateLimitRedisMetricsSnapshot = (): {
  readonly redisUrlConfigured: 0 | 1;
  readonly redisStoreActive: 0 | 1;
  readonly fallbackEventsTotal: number;
} => ({
  redisUrlConfigured,
  redisStoreActive,
  fallbackEventsTotal,
});

export const resetRestRateLimitRedisMetricsForTests = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  fallbackEventsTotal = 0;
};
