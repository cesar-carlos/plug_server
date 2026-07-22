import { env } from "../../../../shared/config/env";
import { socketEvents } from "../../../../shared/constants/socket_events";

import { consumerRegistry } from "../registries/consumer_registry";

/**
 * Inbound `/consumers` events that represent meaningful user activity for idle timeout.
 *
 * High-frequency hub→consumer traffic (relay stream chunks/responses, command stream
 * chunks, profile push, etc.) must not refresh `lastSeenAt`. Only client-initiated
 * control and RPC paths belong here.
 *
 * Call sites should invoke {@link touchConsumerRegistryOnSocketActivity} only after
 * structural validation (and custom-event Client auth) succeeds — malformed spam,
 * overload sheds, and auth failures must not keep idle sockets alive.
 */
export const consumerIdleTouchEvents = [
  socketEvents.agentsCommand,
  socketEvents.agentsStreamPull,
  socketEvents.relayConversationStart,
  socketEvents.relayConversationEnd,
  socketEvents.relayRpcRequest,
  socketEvents.relayRpcRequestBatch,
  socketEvents.relayRpcStreamPull,
  socketEvents.socketEventSubscribe,
  socketEvents.socketEventUnsubscribe,
  socketEvents.socketEventPublish,
] as const;

export type ConsumerIdleTouchEvent = (typeof consumerIdleTouchEvents)[number];

const consumerIdleTouchEventSet = new Set<string>(consumerIdleTouchEvents);

export const isConsumerIdleTouchEvent = (eventName: string): eventName is ConsumerIdleTouchEvent =>
  consumerIdleTouchEventSet.has(eventName);

const lastTouchAtMsBySocketId = new Map<string, number>();

/** Clears debounce bookkeeping when a consumer socket disconnects. */
export const clearConsumerIdleTouchDebounceState = (socketId: string): void => {
  lastTouchAtMsBySocketId.delete(socketId);
};

/** Test helper — resets all debounce state. */
export const resetConsumerIdleTouchDebounceState = (): void => {
  lastTouchAtMsBySocketId.clear();
};

export const touchConsumerRegistryOnInboundEvent = (
  socketId: string,
  eventName: string,
): ReturnType<typeof consumerRegistry.touch> => {
  if (!isConsumerIdleTouchEvent(eventName)) {
    return null;
  }

  return touchConsumerRegistryOnSocketActivity(socketId);
};

/**
 * Refreshes idle timeout for a registered consumer handler without `onAny`.
 * When {@link env.socketConsumerIdleTouchDebounceMs} is > 0, at most one registry
 * write per socket per debounce window is performed (best-effort touch).
 */
export const touchConsumerRegistryOnSocketActivity = (
  socketId: string,
): ReturnType<typeof consumerRegistry.touch> => {
  const debounceMs = env.socketConsumerIdleTouchDebounceMs;
  if (debounceMs > 0) {
    const nowMs = Date.now();
    const lastTouchMs = lastTouchAtMsBySocketId.get(socketId);
    if (lastTouchMs !== undefined && nowMs - lastTouchMs < debounceMs) {
      return null;
    }
    lastTouchAtMsBySocketId.set(socketId, nowMs);
  }

  const touched = consumerRegistry.touch(socketId);
  if (touched === null) {
    clearConsumerIdleTouchDebounceState(socketId);
  }
  return touched;
};
