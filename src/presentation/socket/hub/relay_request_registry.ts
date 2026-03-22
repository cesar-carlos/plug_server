import type { BridgeLatencyTraceSession } from "../../../application/services/bridge_latency_trace_builder";

import { clearRelayStreamFlowState } from "./relay_stream_flow_state";

export interface RelayRequestRoute {
  readonly requestId: string;
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly agentId: string;
  readonly timeoutHandle: NodeJS.Timeout;
  readonly createdAtMs: number;
  readonly clientRequestId?: string;
  readonly latencyTrace?: BridgeLatencyTraceSession;
  timedOut?: boolean;
}

const relayRequestsByRequestId = new Map<string, RelayRequestRoute>();
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

export const hasRelayRequestRoute = (requestId: string): boolean => relayRequestsByRequestId.has(requestId);

export const getRelayRegisteredRouteCount = (): number => relayRequestsByRequestId.size;

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

export const registerRelayRequestRoute = (route: RelayRequestRoute): void => {
  relayRequestsByRequestId.set(route.requestId, route);
  incrementCounter(relayPendingCountByConversation, route.conversationId);
  incrementCounter(relayPendingCountByConsumer, route.consumerSocketId);
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

  clearTimeout(route.timeoutHandle);
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
    clearTimeout(route.timeoutHandle);
  }
  relayRequestsByRequestId.clear();
  relayPendingCountByConversation.clear();
  relayPendingCountByConsumer.clear();
  relayRequestIdsByConversation.clear();
  relayRequestIdsByConsumer.clear();
  relayRequestIdsByAgent.clear();
};
