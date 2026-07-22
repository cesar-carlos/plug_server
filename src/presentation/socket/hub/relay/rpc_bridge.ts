import type { Namespace, Socket } from "socket.io";

import { socketEvents } from "../../../../shared/constants/socket_events";
import { encodePayloadFrameHotPath } from "../../../../shared/utils/payload_frame";
import type { ActiveStreamRoute } from "../registries/active_stream_registry";
import {
  countRestMaterializeStreamsInFlight,
  getActiveStreamRouteCount,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  buildRelayHubMetricsSnapshot,
  registerAgentFailure,
  relayMetrics,
  scheduleRelayHubMetricsLogger,
  stopRelayHubMetricsLogger,
  type RelayHubMetricsSnapshot,
} from "./bridge_relay_health_metrics";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import {
  getRelayRequestRoute,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import { getRelayStreamForwardedRows } from "./relay_stream_flow_state";
import { touchRelayStreamTimeout } from "../registries/relay_stream_timeout_registry";
import { wireRestAgentDispatchQueueMetrics } from "./rest_agent_dispatch_queue";
import { scheduleRelayIdempotencyCleanupTimer } from "../registries/relay_idempotency_store";
import { createRpcBridgeAgentInboundHandlers } from "./rpc_bridge_agent_inbound";
import { createAgentHubBridgeDispatch } from "./agent_hub_bridge_wiring";
import { createRpcBridgeRelayDispatch } from "./rpc_bridge_dispatch_relay";
import {
  createPrepareAgentStreamPull,
  createRequestAgentStreamPull,
} from "./rpc_bridge_stream_pull";
import { resetRpcBridgeMutableStores } from "./rpc_bridge_lifecycle";
import { wireRelayConsumerEmit } from "./relay_consumer_emit";
import { wireConsumerBridgeSocketLookup } from "./relay_consumer_socket_lookup";

export {
  buildRelayConversationEndedPayload,
  cleanupAgentStreamSubscriptions,
  cleanupConsumerStreamSubscriptions,
  cleanupConversationStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
  finalizeConversationsClosedByConsumerDisconnect,
  finalizeExpiredConversations,
} from "./rpc_bridge_lifecycle";

export type {
  DispatchRpcCommandInput,
  DispatchRpcCommandResult,
} from "./rpc_bridge_dispatch_command";
export type {
  DispatchRelayRpcInput,
  DispatchRelayRpcResult,
  PreparedRelayStreamPull,
  RequestRelayStreamPullInput,
} from "./rpc_bridge_dispatch_relay";
export type {
  PreparedAgentStreamPull,
  RequestAgentStreamPullInput,
  RequestAgentStreamPullResult,
} from "./rpc_bridge_stream_pull";

const agentNamespaces = new Set<Namespace>();
const consumerNamespaces = new Set<Namespace>();
const agentSocketNamespacesById = new Map<string, Namespace>();
const consumerSocketNamespacesById = new Map<string, Namespace>();

type HubNamespaceSocket = Socket;

const findSocketInIndex = (
  namespacesBySocketId: Map<string, Namespace>,
  socketId: string,
): HubNamespaceSocket | null => {
  const namespace = namespacesBySocketId.get(socketId);
  if (!namespace) {
    return null;
  }
  const socket = namespace.sockets.get(socketId);
  if (!socket) {
    namespacesBySocketId.delete(socketId);
    return null;
  }
  return socket;
};

const hasRegisteredAgentSocketBridge = (): boolean => agentNamespaces.size > 0;

const findAgentSocketById = (socketId: string): HubNamespaceSocket | null =>
  findSocketInIndex(agentSocketNamespacesById, socketId);

const findConsumerSocketById = (socketId: string): HubNamespaceSocket | null =>
  findSocketInIndex(consumerSocketNamespacesById, socketId);

export const findAgentBridgeSocketById = (socketId: string): HubNamespaceSocket | null =>
  findAgentSocketById(socketId);

wireRestAgentDispatchQueueMetrics((reason) => {
  if (reason === "queue_full") {
    relayMetrics.restAgentQueueFullRejected += 1;
    return;
  }
  relayMetrics.restAgentQueueWaitTimeoutRejected += 1;
});

export const getRelayMetricsSnapshot = (): RelayHubMetricsSnapshot =>
  buildRelayHubMetricsSnapshot({
    activeStreams: getActiveStreamRouteCount(),
    restMaterializeStreamsInFlight: countRestMaterializeStreamsInFlight(),
    // Use the fast (cached) outbound-queue snapshot on the metrics-read path:
    // the heavy percentile + orphan-tail scan is owned by the conversation
    // sweep timer (`sweepRelayOutboundQueueState` -> overload state refresh),
    // so the `/metrics` scrape and the periodic logger reuse those cached
    // values instead of recomputing them on every read. Same output shape.
    useFastQueueSnapshot: true,
  });

export { stopRelayHubMetricsLogger as stopRelayMetricsLogger };

const emitRpcStreamPullForRoute = (route: ActiveStreamRoute, windowSize: number): void => {
  if (!hasRegisteredAgentSocketBridge() || !route.streamId) {
    return;
  }

  const agentSocket = findAgentSocketById(route.agentSocketId);
  if (!agentSocket) {
    const relayRoute = getRelayRequestRoute(route.requestId);
    const agentId =
      route.agentId ?? relayRoute?.agentId ?? route.restMaterializeState?.agentId;
    if (agentId) {
      registerAgentFailure(agentId, "relay");
    }
    if (route.mode === "relay") {
      const forwardedRows = getRelayStreamForwardedRows(route.requestId);
      const streamId = route.streamId;
      removeRelayRequestRoute(route.requestId);
      removeActiveStreamRoute(route, { restMaterialize: "detach" });
      enqueueRelayOutbound(route.requestId, async () => {
        const frame = await encodeRelayOutboundFrame(
          {
            request_id: route.requestId,
            total_rows: forwardedRows,
            terminal_status: "error",
            ...(streamId ? { stream_id: streamId } : {}),
          },
          route.requestId,
        );
        emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame);
      });
    } else {
      removeActiveStreamRoute(route);
    }
    return;
  }

  const cappedWindow = Math.max(1, Math.floor(windowSize));
  agentSocket.emit(
    socketEvents.rpcStreamPull,
    encodePayloadFrameHotPath(
      {
        stream_id: route.streamId,
        request_id: route.requestId,
        window_size: cappedWindow,
      },
      { requestId: route.requestId },
    ),
  );
  if (route.mode === "relay") {
    touchRelayStreamTimeout(route.requestId);
  }
  relayMetrics.restSqlStreamMaterializePulls += 1;
};

export const registerSocketBridgeServer = (namespace: Namespace): void => {
  agentNamespaces.add(namespace);
};

export const registerConsumerBridgeServer = (namespace: Namespace): void => {
  consumerNamespaces.add(namespace);
  scheduleRelayHubMetricsLogger(() =>
    buildRelayHubMetricsSnapshot({
      activeStreams: getActiveStreamRouteCount(),
      restMaterializeStreamsInFlight: countRestMaterializeStreamsInFlight(),
      useFastQueueSnapshot: true,
    }),
  );
  scheduleRelayIdempotencyCleanupTimer();
};

export const registerAgentBridgeSocket = (namespace: Namespace, socketId: string): void => {
  agentSocketNamespacesById.set(socketId, namespace);
};

export const unregisterAgentBridgeSocket = (socketId: string): void => {
  agentSocketNamespacesById.delete(socketId);
};

export const registerConsumerBridgeSocket = (namespace: Namespace, socketId: string): void => {
  consumerSocketNamespacesById.set(socketId, namespace);
};

export const unregisterConsumerBridgeSocket = (socketId: string): void => {
  consumerSocketNamespacesById.delete(socketId);
};

export const unregisterSocketBridgeServer = (namespace: Namespace): void => {
  agentNamespaces.delete(namespace);
  for (const [socketId, registeredNamespace] of agentSocketNamespacesById.entries()) {
    if (registeredNamespace === namespace) {
      agentSocketNamespacesById.delete(socketId);
    }
  }
};

export const unregisterConsumerBridgeServer = (namespace: Namespace): void => {
  consumerNamespaces.delete(namespace);
  for (const [socketId, registeredNamespace] of consumerSocketNamespacesById.entries()) {
    if (registeredNamespace === namespace) {
      consumerSocketNamespacesById.delete(socketId);
    }
  }
};

const emitToConsumer = (consumerSocketId: string, eventName: string, payload: unknown): boolean => {
  if (consumerNamespaces.size === 0) {
    return false;
  }

  const consumerSocket = findConsumerSocketById(consumerSocketId);
  if (!consumerSocket) {
    relayMetrics.relayEmitDiscardedConsumerGone += 1;
    return false;
  }

  consumerSocket.emit(eventName, payload);
  return true;
};

wireRelayConsumerEmit(emitToConsumer);
wireConsumerBridgeSocketLookup(findConsumerSocketById);

const prepareAgentStreamPull = createPrepareAgentStreamPull({
  hasRegisteredAgentSocketBridge,
  findAgentSocketById,
  emitToConsumer,
});

export const prepareLegacyAgentStreamPull = prepareAgentStreamPull;

export const requestAgentStreamPull = createRequestAgentStreamPull({
  hasRegisteredAgentSocketBridge,
  findAgentSocketById,
  emitToConsumer,
});

const relayRpcHandlers = createRpcBridgeRelayDispatch({
  hasRegisteredAgentSocketBridge,
  findAgentSocketById,
  emitToConsumer,
  prepareAgentStreamPull,
});

export const dispatchRelayRpcToAgent = relayRpcHandlers.dispatchRelayRpcToAgent;
export const prepareRelayStreamPull = relayRpcHandlers.prepareRelayStreamPull;
export const requestRelayStreamPull = relayRpcHandlers.requestRelayStreamPull;

export const dispatchRpcCommandToAgent = createAgentHubBridgeDispatch({
  hasRegisteredAgentSocketBridge,
  findAgentSocketById,
});

const agentInboundHandlers = createRpcBridgeAgentInboundHandlers({
  emitToConsumer,
  emitRpcStreamPullForRoute,
});

export const handleAgentRpcResponse = agentInboundHandlers.handleAgentRpcResponse;
export const handleAgentRpcChunk = agentInboundHandlers.handleAgentRpcChunk;
export const handleAgentRpcComplete = agentInboundHandlers.handleAgentRpcComplete;
export const handleAgentRpcAck = agentInboundHandlers.handleAgentRpcAck;
export const handleAgentBatchAck = agentInboundHandlers.handleAgentBatchAck;
export const cleanupAgentInboundSocketState = agentInboundHandlers.cleanupSocketInboundState;

export const resetSocketBridgeState = (): void => {
  resetRpcBridgeMutableStores();
  agentInboundHandlers.resetInboundState();
  agentNamespaces.clear();
  consumerNamespaces.clear();
  agentSocketNamespacesById.clear();
  consumerSocketNamespacesById.clear();
};
