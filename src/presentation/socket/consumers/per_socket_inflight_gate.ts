/**
 * Per-socket inflight gate for consumer namespace handlers.
 *
 * Each handler (`agents:command`, `relay:rpc.request`, `agents:stream_pull`,
 * `relay:rpc.stream.pull`) wraps its async body in `try { acquire } finally { release }`
 * so that a single socket can have at most `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`
 * concurrent async operations across those event types. When the cap is exceeded,
 * the caller emits an event-specific `RATE_LIMITED` error and skips the body.
 *
 * `socket:event.publish` may use a separate cap via
 * `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` when set > 0 (see
 * {@link tryAcquireCustomPublishInflightSlot}). In that mode the two counters are
 * independent: a socket may hold up to `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`
 * relay/command operations **and** up to `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET`
 * custom publishes concurrently (values add; neither counter includes the other).
 *
 * Setting `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET=0` disables the shared gate.
 */

import type { Socket } from "socket.io";

interface SocketInflightContext {
  inflightCount: number;
}

export type SocketWithInflightCounter = Socket & {
  data: { inflightCounter?: SocketInflightContext };
};

/**
 * Tries to reserve one inflight slot for `socket`. Returns `true` and increments
 * the counter when allowed; returns `false` when the cap is reached. When `max`
 * is `<= 0` the gate is disabled and always returns `true` without bookkeeping.
 */
export const tryAcquireSocketInflightSlot = (
  socket: SocketWithInflightCounter,
  max: number,
): boolean => {
  if (max <= 0) {
    return true;
  }
  const ctx = socket.data.inflightCounter ?? (socket.data.inflightCounter = { inflightCount: 0 });
  if (ctx.inflightCount >= max) {
    return false;
  }
  ctx.inflightCount += 1;
  return true;
};

/**
 * Releases one inflight slot for `socket`. Idempotent against `0`/missing context
 * so it is safe to call from `finally` blocks regardless of whether
 * `tryAcquireSocketInflightSlot` succeeded.
 */
export const releaseSocketInflightSlot = (socket: SocketWithInflightCounter): void => {
  const ctx = socket.data.inflightCounter;
  if (!ctx) {
    return;
  }
  ctx.inflightCount = Math.max(0, ctx.inflightCount - 1);
};

interface CustomPublishInflightContext {
  inflightCount: number;
}

export type SocketWithCustomPublishInflight = Socket & {
  data: { customPublishInflightCounter?: CustomPublishInflightContext };
};

/**
 * When `SOCKET_CUSTOM_EVENT_PUBLISH_MAX_INFLIGHT_PER_SOCKET` > 0, `socket:event.publish` uses this
 * counter instead of the shared {@link tryAcquireSocketInflightSlot} budget.
 */
export const tryAcquireCustomPublishInflightSlot = (
  socket: SocketWithCustomPublishInflight,
  max: number,
): boolean => {
  if (max <= 0) {
    return true;
  }
  const ctx =
    socket.data.customPublishInflightCounter ??
    (socket.data.customPublishInflightCounter = { inflightCount: 0 });
  if (ctx.inflightCount >= max) {
    return false;
  }
  ctx.inflightCount += 1;
  return true;
};

export const releaseCustomPublishInflightSlot = (socket: SocketWithCustomPublishInflight): void => {
  const ctx = socket.data.customPublishInflightCounter;
  if (!ctx) {
    return;
  }
  ctx.inflightCount = Math.max(0, ctx.inflightCount - 1);
};
