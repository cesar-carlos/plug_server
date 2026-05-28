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

export interface AcquireSocketInflightSlotsResult {
  readonly ok: boolean;
  readonly availableSlots: number;
  readonly requestedSlots: number;
}

/**
 * Atomic all-or-nothing acquisition of `count` inflight slots for `socket`.
 * When the gate cannot fit the full batch (cap minus current count < `count`),
 * **no** slot is acquired — the caller can then reject the entire batch with
 * `RATE_LIMITED` and surface `availableSlots` / `requestedSlots` to the
 * consumer. Used by `relay:rpc.request.batch` (see `docs/adrs/0008-relay-batch-protocol.md`).
 *
 * When `max <= 0` the gate is disabled and acquisition always succeeds.
 */
export const tryAcquireSocketInflightSlots = (
  socket: SocketWithInflightCounter,
  count: number,
  max: number,
): AcquireSocketInflightSlotsResult => {
  if (count <= 0) {
    return { ok: true, availableSlots: max, requestedSlots: count };
  }
  if (max <= 0) {
    return { ok: true, availableSlots: Number.POSITIVE_INFINITY, requestedSlots: count };
  }
  const ctx = socket.data.inflightCounter ?? (socket.data.inflightCounter = { inflightCount: 0 });
  const availableSlots = Math.max(0, max - ctx.inflightCount);
  if (availableSlots < count) {
    return { ok: false, availableSlots, requestedSlots: count };
  }
  ctx.inflightCount += count;
  return { ok: true, availableSlots, requestedSlots: count };
};

/**
 * Releases `count` inflight slots in one operation. Idempotent against
 * missing context. Pairs with {@link tryAcquireSocketInflightSlots}; call
 * from a `finally` block to release whatever was acquired.
 */
export const releaseSocketInflightSlots = (
  socket: SocketWithInflightCounter,
  count: number,
): void => {
  if (count <= 0) {
    return;
  }
  const ctx = socket.data.inflightCounter;
  if (!ctx) {
    return;
  }
  ctx.inflightCount = Math.max(0, ctx.inflightCount - count);
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
