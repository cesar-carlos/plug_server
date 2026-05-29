import { env } from "../../../../shared/config/env";
import { createFixedWindowSocketRateLimiter } from "./fixed_window_socket_rate_limiter";

/**
 * Fixed-window rate limit for `socket:event.publish` on `/consumers`.
 * Uses {@link env.socketCustomEventPublishRateLimitWindowMs} and
 * {@link env.socketCustomEventPublishRateLimitMax} (defaults mirror REST
 * `REST_SOCKET_EVENT_RATE_LIMIT_*`; set `SOCKET_CUSTOM_EVENT_PUBLISH_RATE_LIMIT_*` to override Socket-only
 * caps) with a **separate** counter bucket from Express, mirroring {@link allowClientSocketEventPublishSocketAsync}.
 */

const limiter = createFixedWindowSocketRateLimiter({
  redisScope: "client_socket_event_publish",
  getWindowMs: () => env.socketCustomEventPublishRateLimitWindowMs,
  getMax: () => env.socketCustomEventPublishRateLimitMax,
});

const buildIdentityKey = (clientSub: string): string => {
  const trimmed = clientSub.trim();
  return `client:${trimmed}`;
};

export const allowClientSocketEventPublishSocket = (clientSub: string): boolean =>
  limiter.allow(buildIdentityKey(clientSub));

export const allowClientSocketEventPublishSocketAsync = async (
  clientSub: string,
): Promise<boolean> => limiter.allowAsync(buildIdentityKey(clientSub));

export const refundClientSocketEventPublishSocket = (clientSub: string, cost = 1): void =>
  limiter.refund(buildIdentityKey(clientSub), cost);

export const refundClientSocketEventPublishSocketAsync = async (
  clientSub: string,
  cost = 1,
): Promise<void> => limiter.refundAsync(buildIdentityKey(clientSub), cost);

export const sweepClientSocketEventPublishSocketRateLimitState = (): void => limiter.sweep();

export const resetClientSocketEventPublishSocketRateLimitState = (): void => limiter.reset();

export const getClientSocketEventPublishSocketRateLimitMetricsSnapshot = (): {
  readonly windowMs: number;
  readonly maxPerWindow: number;
  readonly trackedKeys: number;
  readonly allowedTotal: number;
  readonly rejectedTotal: number;
} => ({
  windowMs: env.socketCustomEventPublishRateLimitWindowMs,
  maxPerWindow: env.socketCustomEventPublishRateLimitMax,
  trackedKeys: limiter.trackedKeyCount(),
  allowedTotal: limiter.allowedTotal(),
  rejectedTotal: limiter.rejectedTotal(),
});
