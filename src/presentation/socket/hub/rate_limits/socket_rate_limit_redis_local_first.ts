import {
  consumeSocketRateLimitRedis,
  type SocketRateLimitRedisConsumeInput,
} from "../../../../infrastructure/redis/rate_limit/socket_rate_limit_redis";
import { env } from "../../../../shared/config/env";

export interface SocketRateLimitLocalFirstHandlers {
  /** Consume quota on the in-process fixed window; must record channel metrics when applicable. */
  readonly allowLocal: () => boolean;
  /** Roll back a prior {@link allowLocal} consume when async Redis reconciliation denies. */
  readonly refundLocal: () => void;
  /** Called only on the legacy await-Redis path when Redis returns a decision. */
  readonly onLegacyRedisDecision: (allowed: boolean) => void;
}

const isLocalFirstActive = (): boolean =>
  env.socketRateLimitRedisLocalFirst && env.socketRateLimitRedisUrl.trim() !== "";

/**
 * Redis-backed socket rate-limit consume with an optional local-first fast path.
 *
 * Default (`SOCKET_RATE_LIMIT_REDIS_LOCAL_FIRST=false`): awaits Redis and falls back to
 * {@link handlers.allowLocal} only when Redis is unavailable (fail-open), matching the
 * pre-change behavior.
 *
 * Local-first (`SOCKET_RATE_LIMIT_REDIS_LOCAL_FIRST=true` and Redis URL configured):
 * - **Deny**: consults the in-process window only and skips the Redis RTT.
 * - **Allow**: consumes local quota synchronously, then reconciles with Redis in the
 *   background. If Redis denies, {@link handlers.refundLocal} runs so this replica's
 *   shadow counter realigns; the caller that already received `true` is not retroactively
 *   rejected.
 *
 * Multi-replica tradeoff: under synchronized burst each replica may admit up to `max`
 * requests per window before Redis converges, so the global budget can be briefly exceeded
 * by roughly `(replicaCount - 1) * max`. Opt in only when hub CPU/RTT dominates and ops
 * accept softer cross-replica enforcement.
 */
export const consumeSocketRateLimitLocalFirstAsync = async (
  input: SocketRateLimitRedisConsumeInput,
  handlers: SocketRateLimitLocalFirstHandlers,
): Promise<boolean> => {
  if (!isLocalFirstActive()) {
    const redisDecision = await consumeSocketRateLimitRedis(input);
    if (redisDecision) {
      handlers.onLegacyRedisDecision(redisDecision.allowed);
      return redisDecision.allowed;
    }
    return handlers.allowLocal();
  }

  if (!handlers.allowLocal()) {
    return false;
  }

  void reconcileSocketRateLimitRedisConsume(input, handlers.refundLocal);
  return true;
};

const reconcileSocketRateLimitRedisConsume = async (
  input: SocketRateLimitRedisConsumeInput,
  refundLocal: () => void,
): Promise<void> => {
  const redisDecision = await consumeSocketRateLimitRedis(input);
  if (redisDecision === null) {
    // Fail-open: local consume stands, same as the legacy Redis-unavailable fallback.
    return;
  }
  if (!redisDecision.allowed) {
    refundLocal();
  }
};
