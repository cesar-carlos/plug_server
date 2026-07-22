import { env } from "../../../../shared/config/env";
import {
  consumeSocketRateLimitRedis,
  refundSocketRateLimitRedis,
} from "../../../../infrastructure/redis/rate_limit/socket_rate_limit_redis";

const buckets = new Map<string, { readonly stamps: number[]; lastSeenAtMs: number }>();

const bucketKey = (userId: string, agentId: string): string => `${userId}:${agentId}`;

/** Optional overrides for tests (`socket.ts` omits this). */
export type AgentRegisterRateLimitConsumeOptions = {
  readonly windowMs?: number;
  readonly max?: number;
};

/**
 * Sliding-window limit on `agent:register` attempts per `(userId, agentId)`.
 * Disabled when `SOCKET_AGENT_REGISTER_RATE_LIMIT_WINDOW_MS` or `_MAX` is 0.
 */
export const tryConsumeAgentRegisterRateLimit = (
  userId: string,
  agentId: string,
  options?: AgentRegisterRateLimitConsumeOptions,
): { ok: true } | { ok: false } => {
  const windowMs = options?.windowMs ?? env.socketAgentRegisterRateLimitWindowMs;
  const max = options?.max ?? env.socketAgentRegisterRateLimitMax;
  if (windowMs <= 0 || max <= 0) {
    return { ok: true };
  }

  const key = bucketKey(userId, agentId);
  const nowMs = Date.now();
  const cutoff = nowMs - windowMs;
  const existing = buckets.get(key);
  const stamps = existing?.stamps ?? [];
  const fresh = stamps.filter((t) => t > cutoff);

  if (fresh.length === 0 && stamps.length > 0) {
    buckets.delete(key);
  }

  if (fresh.length >= max) {
    buckets.set(key, { stamps: fresh, lastSeenAtMs: nowMs });
    return { ok: false };
  }

  fresh.push(nowMs);
  buckets.set(key, { stamps: fresh, lastSeenAtMs: nowMs });
  return { ok: true };
};

export const tryConsumeAgentRegisterRateLimitAsync = async (
  userId: string,
  agentId: string,
  options?: AgentRegisterRateLimitConsumeOptions,
): Promise<{ ok: true } | { ok: false }> => {
  const windowMs = options?.windowMs ?? env.socketAgentRegisterRateLimitWindowMs;
  const max = options?.max ?? env.socketAgentRegisterRateLimitMax;
  if (windowMs <= 0 || max <= 0) {
    return { ok: true };
  }

  const redisDecision = await consumeSocketRateLimitRedis({
    scope: "agent_register",
    key: bucketKey(userId, agentId),
    windowMs,
    max,
  });
  if (redisDecision) {
    return redisDecision.allowed ? { ok: true } : { ok: false };
  }

  return tryConsumeAgentRegisterRateLimit(userId, agentId, options);
};

/**
 * Give back one attempt after a post-consume soft denial (e.g. SESSION_ACTIVE
 * race between peek and register). No-op when there is no local stamp to refund.
 */
export const refundAgentRegisterRateLimit = (userId: string, agentId: string): void => {
  const key = bucketKey(userId, agentId);
  const existing = buckets.get(key);
  if (!existing || existing.stamps.length === 0) {
    return;
  }
  const stamps = existing.stamps.slice(0, -1);
  if (stamps.length === 0) {
    buckets.delete(key);
    return;
  }
  buckets.set(key, { stamps, lastSeenAtMs: existing.lastSeenAtMs });
};

export const refundAgentRegisterRateLimitAsync = async (
  userId: string,
  agentId: string,
): Promise<void> => {
  const windowMs = env.socketAgentRegisterRateLimitWindowMs;
  const max = env.socketAgentRegisterRateLimitMax;
  if (windowMs > 0 && max > 0) {
    await refundSocketRateLimitRedis({
      scope: "agent_register",
      key: bucketKey(userId, agentId),
    });
  }
  refundAgentRegisterRateLimit(userId, agentId);
};

export const resetAgentRegisterRateLimitState = (): void => {
  buckets.clear();
};

export const sweepAgentRegisterRateLimitState = (): void => {
  const windowMs = env.socketAgentRegisterRateLimitWindowMs;
  const staleAfterMs = windowMs * env.socketRelayRateLimitSweepStaleMultiplier;
  if (staleAfterMs <= 0) {
    return;
  }
  const nowMs = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (nowMs - bucket.lastSeenAtMs >= staleAfterMs) {
      buckets.delete(key);
    }
  }
};
