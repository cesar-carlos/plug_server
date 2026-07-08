import { socketEvents } from "../../../../shared/constants/socket_events";

import { consumerRegistry } from "../registries/consumer_registry";

/**
 * Inbound `/consumers` events that represent meaningful user activity for idle timeout.
 *
 * High-frequency hub→consumer traffic (relay stream chunks/responses, command stream
 * chunks, profile push, etc.) must not refresh `lastSeenAt`. Only client-initiated
 * control and RPC paths belong here.
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

export const touchConsumerRegistryOnInboundEvent = (
  socketId: string,
  eventName: string,
): ReturnType<typeof consumerRegistry.touch> => {
  if (!isConsumerIdleTouchEvent(eventName)) {
    return null;
  }

  return consumerRegistry.touch(socketId);
};

/** Refreshes idle timeout for a registered consumer handler without `onAny`. */
export const touchConsumerRegistryOnSocketActivity = (
  socketId: string,
): ReturnType<typeof consumerRegistry.touch> => consumerRegistry.touch(socketId);
