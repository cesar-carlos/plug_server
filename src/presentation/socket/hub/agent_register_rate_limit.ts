import { env } from "../../../shared/config/env";

const buckets = new Map<string, number[]>();

const bucketKey = (userId: string, agentId: string): string => `${userId}:${agentId}`;

/**
 * Sliding-window limit on `agent:register` attempts per `(userId, agentId)`.
 * Disabled when `SOCKET_AGENT_REGISTER_RATE_LIMIT_WINDOW_MS` or `_MAX` is 0.
 */
export const tryConsumeAgentRegisterRateLimit = (
  userId: string,
  agentId: string,
): { ok: true } | { ok: false } => {
  const windowMs = env.socketAgentRegisterRateLimitWindowMs;
  const max = env.socketAgentRegisterRateLimitMax;
  if (windowMs <= 0 || max <= 0) {
    return { ok: true };
  }

  const key = bucketKey(userId, agentId);
  const nowMs = Date.now();
  const cutoff = nowMs - windowMs;
  const stamps = buckets.get(key) ?? [];
  const fresh = stamps.filter((t) => t > cutoff);
  if (fresh.length >= max) {
    return { ok: false };
  }

  fresh.push(nowMs);
  buckets.set(key, fresh);
  return { ok: true };
};

export const resetAgentRegisterRateLimitState = (): void => {
  buckets.clear();
};
