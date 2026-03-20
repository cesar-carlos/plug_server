import { serviceUnavailable } from "../../../shared/errors/http_errors";
import {
  getActiveStreamRouteByRequestId,
  listActiveStreamRequestIdsForConversation,
  listStreamRequestIdsForAgent,
  listStreamRequestIdsForConsumer,
  removeActiveStreamRoute,
  resetActiveStreamRegistry,
} from "./active_stream_registry";
import {
  registerAgentFailure,
  resetRelayHubHealthAndMetrics,
  stopRelayHubMetricsLogger,
} from "./bridge_relay_health_metrics";
import { resetRestAgentDispatchQueue } from "./rest_agent_dispatch_queue";
import { restSqlStreamMaterializeReset } from "./rest_sql_stream_materialize";
import type { PendingRequest } from "./rest_pending_requests";
import {
  clearRestPendingRequest,
  forEachUniqueRestPendingRequest,
  resetRestPendingRequestsStore,
} from "./rest_pending_requests";
import {
  clearRelayIdempotencyForConversation,
  resetRelayIdempotencyStore,
  stopRelayIdempotencyCleanupTimer,
} from "./relay_idempotency_store";
import { resetRelayStreamFlowState } from "./relay_stream_flow_state";
import {
  getRelayRequestRoute,
  listRelayRequestIdsForAgent,
  listRelayRequestIdsForConsumer,
  listRelayRequestIdsForConversation,
  removeRelayRequestRoute,
  resetRelayRequestRegistry,
} from "./relay_request_registry";

export const cleanupConsumerStreamSubscriptions = (consumerSocketId: string): void => {
  const streamIds = listStreamRequestIdsForConsumer(consumerSocketId);
  for (const requestId of streamIds) {
    const route = getActiveStreamRouteByRequestId(requestId);
    if (!route || route.consumerSocketId !== consumerSocketId) {
      continue;
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
    }
    removeActiveStreamRoute(route);
  }

  const relayIds = listRelayRequestIdsForConsumer(consumerSocketId);
  for (const requestId of relayIds) {
    removeRelayRequestRoute(requestId);
  }
};

export const cleanupAgentStreamSubscriptions = (agentSocketId: string): void => {
  const streamIds = listStreamRequestIdsForAgent(agentSocketId);
  for (const requestId of streamIds) {
    const route = getActiveStreamRouteByRequestId(requestId);
    if (!route || route.agentSocketId !== agentSocketId) {
      continue;
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
    }
    removeActiveStreamRoute(route);
  }

  const relayAgentIds = listRelayRequestIdsForAgent(agentSocketId);
  for (const requestId of relayAgentIds) {
    const route = getRelayRequestRoute(requestId);
    if (!route || route.agentSocketId !== agentSocketId) {
      continue;
    }
    registerAgentFailure(route.agentId);
    removeRelayRequestRoute(requestId);
  }
};

export const cleanupPendingRequestsForAgentSocket = (agentSocketId: string): number => {
  const uniquePending = new Set<PendingRequest>();
  let cleaned = 0;

  forEachUniqueRestPendingRequest((pending) => {
    if (pending.socketId === agentSocketId) {
      uniquePending.add(pending);
    }
  });

  for (const pending of uniquePending) {
    clearTimeout(pending.timeoutHandle);
    clearRestPendingRequest(pending);
    const existingStream = getActiveStreamRouteByRequestId(pending.primaryRequestId);
    if (existingStream && existingStream.agentSocketId === agentSocketId) {
      removeActiveStreamRoute(existingStream);
    }
    registerAgentFailure(pending.agentId);
    pending.reject(serviceUnavailable("Agent disconnected while waiting for response"));
    cleaned += 1;
  }

  return cleaned;
};

export const cleanupConversationStreamSubscriptions = (conversationId: string): void => {
  const streamRequestIds = listActiveStreamRequestIdsForConversation(conversationId);
  for (const requestId of streamRequestIds) {
    const route = getActiveStreamRouteByRequestId(requestId);
    if (!route) {
      continue;
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
    }
    removeActiveStreamRoute(route);
  }

  const relayRequestIds = listRelayRequestIdsForConversation(conversationId);
  for (const requestId of relayRequestIds) {
    removeRelayRequestRoute(requestId);
  }

  clearRelayIdempotencyForConversation(conversationId);
};

/**
 * Resets all bridge registries and timers that live outside Socket.IO namespace handles.
 * Call from `rpc_bridge.resetSocketBridgeState` after clearing agent/consumer namespace refs.
 */
export const resetRpcBridgeMutableStores = (): void => {
  forEachUniqueRestPendingRequest((pending) => {
    clearTimeout(pending.timeoutHandle);
  });
  resetRestPendingRequestsStore();

  resetRelayRequestRegistry();

  resetActiveStreamRegistry();
  resetRelayIdempotencyStore();
  resetRelayStreamFlowState();
  restSqlStreamMaterializeReset();
  resetRelayHubHealthAndMetrics();
  resetRestAgentDispatchQueue(serviceUnavailable("REST agent queue has been reset"));

  stopRelayHubMetricsLogger();
  stopRelayIdempotencyCleanupTimer();
};
