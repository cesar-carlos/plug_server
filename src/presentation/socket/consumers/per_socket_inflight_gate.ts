/**
 * Per-socket inflight gate for consumer namespace handlers.
 *
 * Each handler (`agents:command`, `relay:rpc.request`, `agents:stream_pull`,
 * `relay:rpc.stream.pull`) wraps its async body in `try { acquire } finally { release }`
 * so that a single socket can have at most `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET`
 * concurrent async operations across all event types. When the cap is exceeded,
 * the caller emits an event-specific `RATE_LIMITED` error and skips the body.
 *
 * Setting `SOCKET_CONSUMER_MAX_INFLIGHT_PER_SOCKET=0` disables the gate.
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
