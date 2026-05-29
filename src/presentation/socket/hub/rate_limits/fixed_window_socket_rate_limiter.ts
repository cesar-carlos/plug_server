import {
  consumeSocketRateLimitRedis,
  refundSocketRateLimitRedis,
  type SocketRateLimitScope,
} from "../../../../infrastructure/redis/rate_limit/socket_rate_limit_redis";
import { env } from "../../../../shared/config/env";

interface WindowState {
  windowStartMs: number;
  count: number;
  lastSeenAtMs: number;
}

export interface FixedWindowSocketRateLimiterConfig {
  /** Redis bucket scope (counters stay isolated per scope and from the Express limiter). */
  readonly redisScope: SocketRateLimitScope;
  /** Window length; read lazily so env overrides applied after import are honored. */
  readonly getWindowMs: () => number;
  /** Per-window cap; `0` disables enforcement (always allows). Read lazily for the same reason. */
  readonly getMax: () => number;
}

export interface FixedWindowSocketRateLimiter {
  /** In-memory fixed-window check. Returns `false` when adding `cost` would exceed the cap. */
  allow(key: string, cost?: number): boolean;
  /** Redis-backed check with in-memory fallback when Redis is unavailable. */
  allowAsync(key: string, cost?: number): Promise<boolean>;
  /** Give back previously consumed budget on the in-memory bucket. */
  refund(key: string, cost?: number): void;
  /** Give back budget on both the Redis and in-memory buckets. */
  refundAsync(key: string, cost?: number): Promise<void>;
  /** Drop buckets not seen within the stale window (called by the periodic sweeper). */
  sweep(): void;
  /** Remove a single bucket (e.g. an anonymous per-socket key on disconnect). */
  deleteKey(key: string): void;
  /** Reset all in-memory state and counters (test/bootstrap helper). */
  reset(): void;
  /** Number of currently tracked buckets (for metrics snapshots). */
  trackedKeyCount(): number;
  readonly allowedTotal: () => number;
  readonly rejectedTotal: () => number;
}

/**
 * Builds a fixed-window socket rate limiter: an in-memory per-key counter that
 * resets each window, with an optional Redis-backed shared counter (and
 * in-memory fallback when Redis is down). Extracted so the per-channel limiters
 * (`agents:command`, `socket:event.publish`, …) share one audited algorithm
 * instead of duplicating it. Callers own key construction, cost estimation and
 * the channel-specific metrics snapshot shape.
 */
export const createFixedWindowSocketRateLimiter = (
  config: FixedWindowSocketRateLimiterConfig,
): FixedWindowSocketRateLimiter => {
  const statesByKey = new Map<string, WindowState>();
  const metrics = { allowed: 0, rejected: 0 };

  const staleAfterMs = (): number =>
    config.getWindowMs() * env.socketRelayRateLimitSweepStaleMultiplier;

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

    if (nowMs - existing.windowStartMs >= config.getWindowMs()) {
      existing.windowStartMs = nowMs;
      existing.count = 0;
    }
    existing.lastSeenAtMs = nowMs;
    return existing;
  };

  const allow = (key: string, cost = 1): boolean => {
    if (config.getMax() === 0) {
      return true;
    }
    const state = ensureState(key);
    const safeCost = Math.max(1, Math.floor(cost));
    if (state.count + safeCost > config.getMax()) {
      metrics.rejected += 1;
      return false;
    }
    state.count += safeCost;
    metrics.allowed += 1;
    return true;
  };

  const allowAsync = async (key: string, cost = 1): Promise<boolean> => {
    if (config.getMax() === 0) {
      return true;
    }
    const safeCost = Math.max(1, Math.floor(cost));
    const redisDecision = await consumeSocketRateLimitRedis({
      scope: config.redisScope,
      key,
      windowMs: config.getWindowMs(),
      max: config.getMax(),
      cost: safeCost,
    });
    if (redisDecision) {
      if (redisDecision.allowed) {
        metrics.allowed += 1;
        return true;
      }
      metrics.rejected += 1;
      return false;
    }

    return allow(key, safeCost);
  };

  const refund = (key: string, cost = 1): void => {
    const state = statesByKey.get(key);
    if (!state || state.count <= 0) {
      return;
    }
    state.count = Math.max(0, state.count - Math.max(1, Math.floor(cost)));
  };

  const refundAsync = async (key: string, cost = 1): Promise<void> => {
    const safeCost = Math.max(1, Math.floor(cost));
    await refundSocketRateLimitRedis({ scope: config.redisScope, key, cost: safeCost });
    refund(key, safeCost);
  };

  const sweep = (): void => {
    const nowMs = Date.now();
    const staleMs = staleAfterMs();
    for (const [mapKey, state] of statesByKey.entries()) {
      if (nowMs - state.lastSeenAtMs >= staleMs) {
        statesByKey.delete(mapKey);
      }
    }
  };

  const deleteKey = (key: string): void => {
    statesByKey.delete(key);
  };

  const reset = (): void => {
    statesByKey.clear();
    metrics.allowed = 0;
    metrics.rejected = 0;
  };

  return {
    allow,
    allowAsync,
    refund,
    refundAsync,
    sweep,
    deleteKey,
    reset,
    trackedKeyCount: () => statesByKey.size,
    allowedTotal: () => metrics.allowed,
    rejectedTotal: () => metrics.rejected,
  };
};
