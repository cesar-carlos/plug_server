import type { BridgeLatencyTraceSession } from "../../../../application/services/bridge_latency_trace_builder";
import { env } from "../../../../shared/config/env";

import { clearRelayStreamFlowState } from "../relay/relay_stream_flow_state";

export interface RelayRequestRoute {
  readonly requestId: string;
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly agentId: string;
  readonly jsonRpcMethod?: string;
  readonly timeoutHandle: NodeJS.Timeout;
  readonly createdAtMs: number;
  readonly clientRequestId?: string;
  readonly latencyTrace?: BridgeLatencyTraceSession;
  readonly releaseAgentDispatchSlot?: () => void;
  /**
   * When `true`, the hub injects `meta.serverTimings` into the outbound
   * `relay:rpc.response` payload — see `relay_rpc_request.handler.ts` and
   * `rpc_bridge_agent_inbound.ts`. Opt-in to keep response size unchanged for
   * consumers that do not consume timings.
   */
  readonly requestServerTimings?: boolean;
  /**
   * When `true`, the consumer asked for the unary fast-path: the hub does NOT
   * emit `relay:rpc.accepted` for this request, and `deduplicated` / `replayed`
   * / `inFlight` state is signalled on `relay:rpc.response` instead. Streaming
   * RPCs are forbidden when this flag is set — see
   * `docs/socket_relay_protocol.md` ("Relay unary fast-path").
   */
  readonly fastPath?: boolean;
  acked?: boolean | undefined;
  ackRetryTimer?: NodeJS.Timeout | undefined;
  ackRetriesAttempted?: number | undefined;
  timedOut?: boolean | undefined;
  /**
   * Set synchronously before enqueueing any terminal outbound response so
   * timeout, success, and synthetic error paths cannot double-deliver.
   */
  settled?: boolean | undefined;
}

export interface RelayPendingSlotReservation {
  readonly release: () => void;
}

const relayRequestsByRequestId = new Map<string, RelayRequestRoute>();
let relayReservedGlobalCount = 0;
const relayPendingCountByConversation = new Map<string, number>();
const relayPendingCountByConsumer = new Map<string, number>();
const relayRequestIdsByConversation = new Map<string, Set<string>>();
const relayRequestIdsByConsumer = new Map<string, Set<string>>();
const relayRequestIdsByAgent = new Map<string, Set<string>>();

const incrementCounter = (counterMap: Map<string, number>, key: string): void => {
  counterMap.set(key, (counterMap.get(key) ?? 0) + 1);
};

const decrementCounter = (counterMap: Map<string, number>, key: string): void => {
  const nextValue = (counterMap.get(key) ?? 0) - 1;
  if (nextValue > 0) {
    counterMap.set(key, nextValue);
    return;
  }

  counterMap.delete(key);
};

const addToIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  index.set(key, new Set([value]));
};

const removeFromIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (!existing) {
    return;
  }

  existing.delete(value);
  if (existing.size === 0) {
    index.delete(key);
  }
};

export const getRelayRequestRoute = (requestId: string): RelayRequestRoute | undefined =>
  relayRequestsByRequestId.get(requestId);

export const hasRelayRequestRoute = (requestId: string): boolean =>
  relayRequestsByRequestId.has(requestId);

export const getRelayRegisteredRouteCount = (): number => relayRequestsByRequestId.size;

export const getRelayEffectivePendingCount = (): number =>
  relayRequestsByRequestId.size + relayReservedGlobalCount;

export const reserveRelayPendingSlot = (
  conversationId: string,
  consumerSocketId: string,
): RelayPendingSlotReservation | null => {
  if (getRelayEffectivePendingCount() >= env.socketRelayMaxPendingRequests) {
    return null;
  }
  if (
    getRelayPendingRequestCountForConversation(conversationId) >=
    env.socketRelayMaxPendingRequestsPerConversation
  ) {
    return null;
  }
  if (
    getRelayPendingRequestCountForConsumer(consumerSocketId) >=
    env.socketRelayMaxPendingRequestsPerConsumer
  ) {
    return null;
  }

  relayReservedGlobalCount += 1;
  incrementCounter(relayPendingCountByConversation, conversationId);
  incrementCounter(relayPendingCountByConsumer, consumerSocketId);

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      relayReservedGlobalCount = Math.max(0, relayReservedGlobalCount - 1);
      decrementCounter(relayPendingCountByConversation, conversationId);
      decrementCounter(relayPendingCountByConsumer, consumerSocketId);
    },
  };
};

export const getRelayPendingRequestCountForConversation = (conversationId: string): number =>
  relayPendingCountByConversation.get(conversationId) ?? 0;

export const getRelayPendingRequestCountForConsumer = (consumerSocketId: string): number =>
  relayPendingCountByConsumer.get(consumerSocketId) ?? 0;

export const findRelayRequestRouteForAgentSocket = (
  candidateIds: readonly string[],
  agentSocketId: string,
): RelayRequestRoute | undefined => {
  for (const id of candidateIds) {
    const route = relayRequestsByRequestId.get(id);
    if (route && route.agentSocketId === agentSocketId) {
      return route;
    }
  }
  return undefined;
};

export const listRelayRequestIdsForConversation = (conversationId: string): string[] =>
  Array.from(relayRequestIdsByConversation.get(conversationId) ?? []);

export const listRelayRequestIdsForConsumer = (consumerSocketId: string): string[] =>
  Array.from(relayRequestIdsByConsumer.get(consumerSocketId) ?? []);

export const listRelayRequestIdsForAgent = (agentSocketId: string): string[] =>
  Array.from(relayRequestIdsByAgent.get(agentSocketId) ?? []);

export const registerRelayRequestRoute = (
  route: RelayRequestRoute,
  options?: { countersReserved?: boolean },
): void => {
  if (relayRequestsByRequestId.has(route.requestId)) {
    removeRelayRequestRoute(route.requestId);
  }

  relayRequestsByRequestId.set(route.requestId, route);
  if (options?.countersReserved === true) {
    relayReservedGlobalCount = Math.max(0, relayReservedGlobalCount - 1);
  } else {
    incrementCounter(relayPendingCountByConversation, route.conversationId);
    incrementCounter(relayPendingCountByConsumer, route.consumerSocketId);
  }
  addToIndex(relayRequestIdsByConversation, route.conversationId, route.requestId);
  addToIndex(relayRequestIdsByConsumer, route.consumerSocketId, route.requestId);
  addToIndex(relayRequestIdsByAgent, route.agentSocketId, route.requestId);
};

export const removeRelayRequestRoute = (requestId: string): RelayRequestRoute | null => {
  const route = relayRequestsByRequestId.get(requestId);
  if (!route) {
    clearRelayStreamFlowState(requestId);
    return null;
  }

  if (route.ackRetryTimer !== undefined) {
    clearTimeout(route.ackRetryTimer);
    delete route.ackRetryTimer;
  }
  clearTimeout(route.timeoutHandle);
  route.releaseAgentDispatchSlot?.();
  relayRequestsByRequestId.delete(requestId);
  decrementCounter(relayPendingCountByConversation, route.conversationId);
  decrementCounter(relayPendingCountByConsumer, route.consumerSocketId);
  removeFromIndex(relayRequestIdsByConversation, route.conversationId, requestId);
  removeFromIndex(relayRequestIdsByConsumer, route.consumerSocketId, requestId);
  removeFromIndex(relayRequestIdsByAgent, route.agentSocketId, requestId);
  clearRelayStreamFlowState(requestId);
  return route;
};

export const resetRelayRequestRegistry = (): void => {
  for (const route of relayRequestsByRequestId.values()) {
    if (route.ackRetryTimer !== undefined) {
      clearTimeout(route.ackRetryTimer);
      delete route.ackRetryTimer;
    }
    clearTimeout(route.timeoutHandle);
    route.releaseAgentDispatchSlot?.();
    clearRelayStreamFlowState(route.requestId);
  }
  relayRequestsByRequestId.clear();
  relayReservedGlobalCount = 0;
  relayPendingCountByConversation.clear();
  relayPendingCountByConsumer.clear();
  relayRequestIdsByConversation.clear();
  relayRequestIdsByConsumer.clear();
  relayRequestIdsByAgent.clear();
};
