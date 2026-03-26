import type { Namespace } from "socket.io";

import { socketEvents } from "../../../shared/constants/socket_events";
import { encodePayloadFrame } from "../../../shared/utils/payload_frame";
import type { ActiveStreamRoute } from "./active_stream_registry";
import { countRestMaterializeStreamsInFlight, getActiveStreamRouteCount } from "./active_stream_registry";
import {
  buildRelayHubMetricsSnapshot,
  relayMetrics,
  scheduleRelayHubMetricsLogger,
  stopRelayHubMetricsLogger,
  type RelayHubMetricsSnapshot,
} from "./bridge_relay_health_metrics";
import { wireRestAgentDispatchQueueMetrics } from "./rest_agent_dispatch_queue";
import { scheduleRelayIdempotencyCleanupTimer } from "./relay_idempotency_store";
import { createRpcBridgeAgentInboundHandlers } from "./rpc_bridge_agent_inbound";
import { createDispatchRpcCommandToAgent } from "./rpc_bridge_dispatch_command";
import { createRpcBridgeRelayDispatch } from "./rpc_bridge_dispatch_relay";
import { createRequestAgentStreamPull } from "./rpc_bridge_stream_pull";
import { resetRpcBridgeMutableStores } from "./rpc_bridge_lifecycle";

export {
  cleanupAgentStreamSubscriptions,
  cleanupConsumerStreamSubscriptions,
  cleanupConversationStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
} from "./rpc_bridge_lifecycle";

export type { DispatchRpcCommandInput, DispatchRpcCommandResult } from "./rpc_bridge_dispatch_command";
export type {
  DispatchRelayRpcInput,
  DispatchRelayRpcResult,
  RequestRelayStreamPullInput,
} from "./rpc_bridge_dispatch_relay";
export type { RequestAgentStreamPullInput, RequestAgentStreamPullResult } from "./rpc_bridge_stream_pull";

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
  scheduleRelayHubMetricsLogger(() => getRelayMetricsSnapshot());
  scheduleRelayIdempotencyCleanupTimer();
};

const emitToConsumer = (
  consumerSocketId: string,
  eventName: string,
  payload: unknown,
): void => {
  const nsp = consumersNamespace;
  if (!nsp) {
    return;
  }

  const consumerSocket = nsp.sockets.get(consumerSocketId);
  if (!consumerSocket) {
    return;
  }

  consumerSocket.emit(eventName, payload);
};

const getAgentsNamespace = (): Namespace | null => agentsNamespace;

export const requestAgentStreamPull = createRequestAgentStreamPull({
  getAgentsNamespace,
  emitToConsumer,
});

const relayRpcHandlers = createRpcBridgeRelayDispatch({
  getAgentsNamespace,
  emitToConsumer,
  requestAgentStreamPull,
});

export const dispatchRelayRpcToAgent = relayRpcHandlers.dispatchRelayRpcToAgent;
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

export const resetSocketBridgeState = (): void => {
  resetRpcBridgeMutableStores();
  agentsNamespace = null;
  consumersNamespace = null;
};
