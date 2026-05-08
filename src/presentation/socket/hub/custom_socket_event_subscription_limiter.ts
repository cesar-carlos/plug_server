import { env } from "../../../shared/config/env";

interface SubscriptionControlBucket {
  windowStartMs: number;
  count: number;
}

export interface CustomSocketEventSubscriptionLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly retryAfterMs?: number;
}

const bucketsBySocketId = new Map<string, SubscriptionControlBucket>();

export const allowCustomSocketEventSubscriptionControl = (
  socketId: string,
  nowMs = Date.now(),
): CustomSocketEventSubscriptionLimitResult => {
  const limit = env.socketCustomEventSubscriptionRateLimitMax;
  const windowMs = env.socketCustomEventSubscriptionRateLimitWindowMs;
  if (limit === 0 || windowMs === 0) {
    return { allowed: true, limit: 0, remaining: Number.POSITIVE_INFINITY, resetAtMs: nowMs };
  }

  const existing = bucketsBySocketId.get(socketId);
  if (!existing || nowMs - existing.windowStartMs >= windowMs) {
    bucketsBySocketId.set(socketId, { windowStartMs: nowMs, count: 1 });
    return { allowed: true, limit, remaining: Math.max(0, limit - 1), resetAtMs: nowMs + windowMs };
  }

  const resetAtMs = existing.windowStartMs + windowMs;
  if (existing.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAtMs,
      retryAfterMs: Math.max(0, resetAtMs - nowMs),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - existing.count),
    resetAtMs,
  };
};

export const clearCustomSocketEventSubscriptionRateLimitState = (socketId: string): void => {
  bucketsBySocketId.delete(socketId);
};

export const resetCustomSocketEventSubscriptionRateLimitState = (): void => {
  bucketsBySocketId.clear();
};
