import { observeBridgeRpcMethod } from "../../../../application/services/bridge_rpc_method_metrics.service";
import { recordSocketAuditEvent } from "../../../../application/services/socket_audit.service";
import { env } from "../../../../shared/config/env";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { noteRelayBodyIdEcho } from "../../../../shared/metrics/socket_consumer.metrics";
import { logger } from "../../../../shared/utils/logger";
import type { ActiveStreamRoute } from "../registries/active_stream_registry";
import {
  getActiveStreamRouteByRequestId,
  listStreamRequestIdsForAgent,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  getRelayIdempotencyMap,
  setRelayIdempotencyEntry,
} from "../registries/relay_idempotency_store";
import type { RelayRequestRoute } from "../registries/relay_request_registry";
import {
  getRelayRequestRoute,
  listRelayRequestIdsForAgent,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import { relayMetrics } from "./bridge_relay_health_metrics";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import { getRelayStreamForwardedRows } from "./relay_stream_flow_state";
import { trySettleRelayRoute } from "./relay_route_settlement";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";

const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

const fanOutIdempotentResponse = (
  route: RelayRequestRoute,
  frame: unknown,
  emitToConsumer: EmitToConsumerFn,
): void => {
  const idempotencyMap = getRelayIdempotencyMap(route.conversationId);
  if (!idempotencyMap || !route.clientRequestId) {
    return;
  }
  const item = idempotencyMap.get(route.clientRequestId);
  if (!item || item.requestId !== route.requestId) {
    return;
  }
  const waiters = item.pendingReplayConsumerSocketIds;
  item.responseFrame = frame;
  item.expiresAtMs = Date.now() + relayIdempotencyTtlMs;
  setRelayIdempotencyEntry(route.conversationId, route.clientRequestId, item);
  if (!waiters || waiters.size === 0) {
    return;
  }
  for (const waiterSocketId of waiters) {
    if (waiterSocketId === route.consumerSocketId) {
      continue;
    }
    emitToConsumer(waiterSocketId, socketEvents.relayRpcResponse, frame);
  }
};

/**
 * Emits a synthetic JSON-RPC error when the agent disconnects before a unary
 * relay response arrives.
 */
export const emitRelayAgentDisconnectedUnary = (
  route: RelayRequestRoute,
  emitToConsumer: EmitToConsumerFn,
): boolean => {
  if (!trySettleRelayRoute(route)) {
    return false;
  }

  clearTimeout(route.timeoutHandle);
  if (route.ackRetryTimer !== undefined) {
    clearTimeout(route.ackRetryTimer);
    delete route.ackRetryTimer;
  }

  const outboundBodyId = route.clientRequestId ?? route.requestId;
  if (outboundBodyId !== route.requestId) {
    noteRelayBodyIdEcho();
  }

  const errorPayload = {
    jsonrpc: "2.0",
    id: outboundBodyId,
    error: {
      code: -32000,
      message: "Agent disconnected while waiting for response",
      data: {
        code: "AGENT_DISCONNECTED",
        conversation_id: route.conversationId,
      },
    },
  };

  route.latencyTrace?.finalizeOnce({
    outcome: "error",
    httpStatus: 503,
    errorCode: "AGENT_DISCONNECTED",
  });
  observeBridgeRpcMethod({
    channel: "relay",
    method: route.jsonRpcMethod ?? "unknown",
    outcome: "error",
    elapsedMs: Date.now() - route.createdAtMs,
  });

  removeRelayRequestRoute(route.requestId);

  enqueueRelayOutbound(route.requestId, async () => {
    const frame = await encodeRelayOutboundFrame(errorPayload, route.requestId);
    emitToConsumer(route.consumerSocketId, socketEvents.relayRpcResponse, frame);
    fanOutIdempotentResponse(route, frame, emitToConsumer);
  });

  return true;
};

/**
 * Emits `relay:rpc.complete` with `terminal_status: "error"` when the agent
 * disconnects during an active relay stream.
 */
export const emitRelayAgentDisconnectedStream = (
  route: RelayRequestRoute,
  activeStream: ActiveStreamRoute,
  emitToConsumer: EmitToConsumerFn,
): boolean => {
  clearTimeout(route.timeoutHandle);
  if (route.ackRetryTimer !== undefined) {
    clearTimeout(route.ackRetryTimer);
    delete route.ackRetryTimer;
  }

  relayMetrics.streamTerminalCompletions += 1;
  const streamId =
    activeStream.streamId ?? getActiveStreamRouteByRequestId(route.requestId)?.streamId;
  const terminalPayload: Record<string, unknown> = {
    request_id: route.requestId,
    total_rows: getRelayStreamForwardedRows(route.requestId),
    terminal_status: "error",
    error_code: "AGENT_DISCONNECTED",
    reason: "agent_disconnected",
    ...(streamId ? { stream_id: streamId } : {}),
  };

  logger.warn("relay_stream_terminated", {
    requestId: route.requestId,
    conversationId: route.conversationId,
    terminalStatus: "error",
    reason: "agent_disconnected",
    ...(streamId ? { streamId } : {}),
  });

  route.latencyTrace?.finalizeOnce({
    outcome: "error",
    httpStatus: 503,
    errorCode: "AGENT_DISCONNECTED",
  });
  observeBridgeRpcMethod({
    channel: "relay",
    method: route.jsonRpcMethod ?? "unknown",
    outcome: "error",
    elapsedMs: Date.now() - route.createdAtMs,
  });

  removeRelayRequestRoute(route.requestId);
  const stillActive = getActiveStreamRouteByRequestId(route.requestId);
  if (stillActive) {
    removeActiveStreamRoute(stillActive);
  }

  enqueueRelayOutbound(route.requestId, async () => {
    const frame = await encodeRelayOutboundFrame(terminalPayload, route.requestId);
    emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame);
    void recordSocketAuditEvent({
      eventType: socketEvents.relayRpcComplete,
      actorSocketId: route.agentSocketId,
      direction: "agent_to_consumer",
      conversationId: route.conversationId,
      agentId: route.agentId,
      requestId: route.requestId,
      ...(streamId ? { streamId } : {}),
    });
  });

  return true;
};

/**
 * Notifies consumers for relay routes owned by a disconnecting agent socket.
 * Returns request ids that received a terminal notification.
 */
export const notifyConsumersForAgentRelayDisconnect = (
  agentSocketId: string,
  emitToConsumer: EmitToConsumerFn,
): Set<string> => {
  const notifiedRequestIds = new Set<string>();

  for (const requestId of listStreamRequestIdsForAgent(agentSocketId)) {
    const activeStream = getActiveStreamRouteByRequestId(requestId);
    if (
      !activeStream ||
      activeStream.agentSocketId !== agentSocketId ||
      activeStream.mode !== "relay"
    ) {
      continue;
    }
    const relayRoute = getRelayRequestRoute(requestId);
    if (!relayRoute || relayRoute.agentSocketId !== agentSocketId) {
      continue;
    }
    if (emitRelayAgentDisconnectedStream(relayRoute, activeStream, emitToConsumer)) {
      notifiedRequestIds.add(requestId);
    }
  }

  for (const requestId of listRelayRequestIdsForAgent(agentSocketId)) {
    if (notifiedRequestIds.has(requestId)) {
      continue;
    }
    const route = getRelayRequestRoute(requestId);
    if (!route || route.agentSocketId !== agentSocketId) {
      continue;
    }
    if (emitRelayAgentDisconnectedUnary(route, emitToConsumer)) {
      notifiedRequestIds.add(requestId);
    }
  }

  return notifiedRequestIds;
};
