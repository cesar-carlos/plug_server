import { env } from "../../../../shared/config/env";
import {
  consumeSocketRateLimitRedis,
  refundSocketRateLimitRedis,
} from "../../../../infrastructure/redis/socket_rate_limit_redis";

/**
 * Fixed-window rate limit for `socket:event.publish` on `/consumers`.
 * Uses {@link env.socketCustomEventPublishRateLimitWindowMs} and
 * {@link env.socketCustomEventPublishRateLimitMax} (defaults mirror REST
 * `REST_SOCKET_EVENT_RATE_LIMIT_*`; set `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_*` to override Socket-only
 * caps) with a **separate** counter bucket from Express, mirroring {@link allowAgentsCommandSocketAsync}.
 */

interface WindowState {
  windowStartMs: number;
  count: number;
  lastSeenAtMs: number;
}

const statesByKey = new Map<string, WindowState>();

const metrics = {
  allowed: 0,
  rejected: 0,
};

const staleAfterMs = (): number =>
  env.socketCustomEventPublishRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;

const buildIdentityKey = (clientSub: string): string => {
  const trimmed = clientSub.trim();
  return `client:${trimmed}`;
};

const ensureState = (key: string): WindowState => {
  const nowMs = Date.now();
  const existing = statesByKey.get(key);
  if (!existing) {
    const created: WindowState = {
      windowStartMs: nowMs,
      count: 0,
      lastSeenAtMs: nowMs,
    };
    statesByKey.set(key, created);
    return created;
  }

  if (nowMs - existing.windowStartMs >= env.socketCustomEventPublishRateLimitWindowMs) {
    existing.windowStartMs = nowMs;
    existing.count = 0;
  }
  existing.lastSeenAtMs = nowMs;
  return existing;
};

export const allowClientSocketEventPublishSocket = (clientSub: string): boolean => {
  if (env.socketCustomEventPublishRateLimitMax === 0) {
    return true;
  }
  const key = buildIdentityKey(clientSub);
  const state = ensureState(key);
  if (state.count + 1 > env.socketCustomEventPublishRateLimitMax) {
    metrics.rejected += 1;
    return false;
  }
  state.count += 1;
  metrics.allowed += 1;
  return true;
};

export const allowClientSocketEventPublishSocketAsync = async (
  clientSub: string,
): Promise<boolean> => {
  if (env.socketCustomEventPublishRateLimitMax === 0) {
    return true;
  }

  const key = buildIdentityKey(clientSub);
  const redisDecision = await consumeSocketRateLimitRedis({
    scope: "client_socket_event_publish",
    key,
    windowMs: env.socketCustomEventPublishRateLimitWindowMs,
    max: env.socketCustomEventPublishRateLimitMax,
    cost: 1,
  });
  if (redisDecision) {
    if (redisDecision.allowed) {
      metrics.allowed += 1;
      return true;
    }
    metrics.rejected += 1;
    return false;
  }

  return allowClientSocketEventPublishSocket(clientSub);
};

export const refundClientSocketEventPublishSocket = (clientSub: string, cost = 1): void => {
  const key = buildIdentityKey(clientSub);
  const state = statesByKey.get(key);
  if (!state || state.count <= 0) {
    return;
  }
  state.count = Math.max(0, state.count - Math.max(1, Math.floor(cost)));
};

export const refundClientSocketEventPublishSocketAsync = async (
  clientSub: string,
  cost = 1,
): Promise<void> => {
  const key = buildIdentityKey(clientSub);
  const safeCost = Math.max(1, Math.floor(cost));
  await refundSocketRateLimitRedis({ scope: "client_socket_event_publish", key, cost: safeCost });
  refundClientSocketEventPublishSocket(clientSub, safeCost);
};

export const sweepClientSocketEventPublishSocketRateLimitState = (): void => {
  const nowMs = Date.now();
  const staleMs = staleAfterMs();
  for (const [mapKey, state] of statesByKey.entries()) {
    if (nowMs - state.lastSeenAtMs >= staleMs) {
      statesByKey.delete(mapKey);
    }
  }
};

export const resetClientSocketEventPublishSocketRateLimitState = (): void => {
  statesByKey.clear();
  metrics.allowed = 0;
  metrics.rejected = 0;
};

export const getClientSocketEventPublishSocketRateLimitMetricsSnapshot = (): {
  readonly windowMs: number;
  readonly maxPerWindow: number;
  readonly trackedKeys: number;
  readonly allowedTotal: number;
  readonly rejectedTotal: number;
} => ({
  windowMs: env.socketCustomEventPublishRateLimitWindowMs,
  maxPerWindow: env.socketCustomEventPublishRateLimitMax,
  trackedKeys: statesByKey.size,
  allowedTotal: metrics.allowed,
  rejectedTotal: metrics.rejected,
});
