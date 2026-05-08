import { env } from "../../../shared/config/env";
import { consumeSocketRateLimitRedis } from "../../../infrastructure/redis/socket_rate_limit_redis";

const buckets = new Map<string, number[]>();

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
  const stamps = buckets.get(key) ?? [];
  const fresh = stamps.filter((t) => t > cutoff);

  if (fresh.length === 0 && stamps.length > 0) {
    buckets.delete(key);
  }

  if (fresh.length >= max) {
    buckets.set(key, fresh);
    return { ok: false };
  }

  fresh.push(nowMs);
  buckets.set(key, fresh);
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

export const resetAgentRegisterRateLimitState = (): void => {
  buckets.clear();
};
