import type { Namespace } from "socket.io";

import { socketEvents } from "../../../shared/constants/socket_events";
import { encodePayloadFrame } from "../../../shared/utils/payload_frame";
import type { ActiveStreamRoute } from "./active_stream_registry";
import {
  countRestMaterializeStreamsInFlight,
  getActiveStreamRouteCount,
  removeActiveStreamRoute,
} from "./active_stream_registry";
import {
  buildRelayHubMetricsSnapshot,
  registerAgentFailure,
  relayMetrics,
  scheduleRelayHubMetricsLogger,
  stopRelayHubMetricsLogger,
  type RelayHubMetricsSnapshot,
} from "./bridge_relay_health_metrics";
import { agentRegistry } from "./agent_registry";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import { getRelayRequestRoute, removeRelayRequestRoute } from "./relay_request_registry";
import { getRelayStreamForwardedRows } from "./relay_stream_flow_state";
import { wireRestAgentDispatchQueueMetrics } from "./rest_agent_dispatch_queue";
import { scheduleRelayIdempotencyCleanupTimer } from "./relay_idempotency_store";
import { createRpcBridgeAgentInboundHandlers } from "./rpc_bridge_agent_inbound";
import { createDispatchRpcCommandToAgent } from "./rpc_bridge_dispatch_command";
import { createRpcBridgeRelayDispatch } from "./rpc_bridge_dispatch_relay";
import {
  createPrepareAgentStreamPull,
  createRequestAgentStreamPull,
} from "./rpc_bridge_stream_pull";
import { resetRpcBridgeMutableStores } from "./rpc_bridge_lifecycle";

export {
  cleanupAgentStreamSubscriptions,
  cleanupConsumerStreamSubscriptions,
  cleanupConversationStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
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

let agentsNamespace: Namespace | null = null;
let consumersNamespace: Namespace | null = null;

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
  });

export { stopRelayHubMetricsLogger as stopRelayMetricsLogger };

const emitRpcStreamPullForRoute = (route: ActiveStreamRoute, windowSize: number): void => {
  const nsp = agentsNamespace;
  if (!nsp || !route.streamId) {
    return;
  }

  const agentSocket = nsp.sockets.get(route.agentSocketId);
  if (!agentSocket) {
    const relayRoute = getRelayRequestRoute(route.requestId);
    const agentId =
      relayRoute?.agentId ??
      route.restMaterializeState?.agentId ??
      agentRegistry.findBySocketId(route.agentSocketId)?.agentId;
    if (agentId) {
      registerAgentFailure(agentId);
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
      removeActiveStreamRoute(route, { restMaterialize: "detach" });
      enqueueRelayOutbound(route.requestId, async () => {
        const frame = await encodeRelayOutboundFrame(
          {
            request_id: route.requestId,
            total_rows: getRelayStreamForwardedRows(route.requestId),
            terminal_status: "error",
            ...(route.streamId ? { stream_id: route.streamId } : {}),
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
    encodePayloadFrame(
      {
        stream_id: route.streamId,
        request_id: route.requestId,
        window_size: cappedWindow,
      },
      { requestId: route.requestId, omitTraceId: true },
    ),
  );
  relayMetrics.restSqlStreamMaterializePulls += 1;
};

export const registerSocketBridgeServer = (namespace: Namespace): void => {
  agentsNamespace = namespace;
};

export const registerConsumerBridgeServer = (namespace: Namespace): void => {
  consumersNamespace = namespace;
  scheduleRelayHubMetricsLogger(() =>
    buildRelayHubMetricsSnapshot({
      activeStreams: getActiveStreamRouteCount(),
      restMaterializeStreamsInFlight: countRestMaterializeStreamsInFlight(),
      useFastQueueSnapshot: true,
    }),
  );
  scheduleRelayIdempotencyCleanupTimer();
};

const emitToConsumer = (consumerSocketId: string, eventName: string, payload: unknown): void => {
  const nsp = consumersNamespace;
  if (!nsp) {
    return;
  }

  const consumerSocket = nsp.sockets.get(consumerSocketId);
  if (!consumerSocket) {
    relayMetrics.relayEmitDiscardedConsumerGone += 1;
    return;
  }

  consumerSocket.emit(eventName, payload);
};

const getAgentsNamespace = (): Namespace | null => agentsNamespace;

const prepareAgentStreamPull = createPrepareAgentStreamPull({
  getAgentsNamespace,
  emitToConsumer,
});

export const requestAgentStreamPull = createRequestAgentStreamPull({
  getAgentsNamespace,
  emitToConsumer,
});

const relayRpcHandlers = createRpcBridgeRelayDispatch({
  getAgentsNamespace,
  emitToConsumer,
  prepareAgentStreamPull,
});

export const dispatchRelayRpcToAgent = relayRpcHandlers.dispatchRelayRpcToAgent;
export const prepareRelayStreamPull = relayRpcHandlers.prepareRelayStreamPull;
export const requestRelayStreamPull = relayRpcHandlers.requestRelayStreamPull;

export const dispatchRpcCommandToAgent = createDispatchRpcCommandToAgent({
  getAgentsNamespace,
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
  agentsNamespace = null;
  consumersNamespace = null;
};
