import { randomBytes } from "node:crypto";

import type { Namespace } from "socket.io";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { badRequest, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { socketEvents } from "../../../shared/constants/socket_events";
import { encodePayloadFrame } from "../../../shared/utils/payload_frame";
import { toRequestId } from "../../../shared/utils/rpc_types";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
  removeActiveStreamRoute,
} from "./active_stream_registry";
import { relayMetrics } from "./bridge_relay_health_metrics";
import { getRelayRequestRoute, removeRelayRequestRoute } from "./relay_request_registry";
import { relayStreamFlowState } from "./relay_stream_flow_state";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";

const defaultStreamWindowSize = 1;

export interface RequestAgentStreamPullInput {
  readonly consumerSocketId: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly requestId?: string;
  readonly windowSize?: number;
}

export interface RequestAgentStreamPullResult {
  readonly requestId: string;
  readonly streamId: string;
  readonly windowSize: number;
}

export interface RpcBridgeStreamPullDeps {
  readonly getAgentsNamespace: () => Namespace | null;
  readonly emitToConsumer: EmitToConsumerFn;
}

export const createRequestAgentStreamPull = (
  deps: RpcBridgeStreamPullDeps,
): ((input: RequestAgentStreamPullInput) => RequestAgentStreamPullResult) => {
  const { getAgentsNamespace, emitToConsumer } = deps;

  return (input: RequestAgentStreamPullInput): RequestAgentStreamPullResult => {
    const resolvedRequestId = input.requestId ? toRequestId(input.requestId) : null;
    const resolvedStreamId = input.streamId ? toRequestId(input.streamId) : null;
    if (!resolvedRequestId && !resolvedStreamId) {
      throw badRequest("Provide streamId or requestId to pull stream chunks");
    }

    const route = resolvedStreamId
      ? getActiveStreamRouteByStreamId(resolvedStreamId)
      : resolvedRequestId
        ? getActiveStreamRouteByRequestId(resolvedRequestId)
        : undefined;

    if (!route) {
      throw notFound("Stream route not found");
    }

    if (route.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Stream route not found");
    }

    if (input.conversationId && route.conversationId !== input.conversationId) {
      throw notFound("Stream route not found");
    }

    const streamId = resolvedStreamId ?? route.streamId;
    if (!streamId) {
      throw badRequest("Stream id is not available yet for this request");
    }

    const nsp = getAgentsNamespace();
    if (!nsp) {
      throw serviceUnavailable("Socket bridge is not initialized");
    }

    const agentSocket = nsp.sockets.get(route.agentSocketId);
    if (!agentSocket) {
      throw serviceUnavailable("Agent socket is unavailable");
    }

    const windowSize =
      typeof input.windowSize === "number" && Number.isFinite(input.windowSize)
        ? Math.max(1, Math.floor(input.windowSize))
        : defaultStreamWindowSize;
    const traceId = randomBytes(16).toString("hex");

    agentSocket.emit(
      socketEvents.rpcStreamPull,
      encodePayloadFrame(
        {
          stream_id: streamId,
          request_id: route.requestId,
          window_size: windowSize,
        },
        {
          requestId: route.requestId,
          traceId,
        },
      ),
    );

    if (route.mode === "relay") {
      relayMetrics.streamPulls += 1;
      const currentCredits = relayStreamFlowState.creditsByRequestId.get(route.requestId) ?? 0;
      let availableCredits = currentCredits + windowSize;
      relayStreamFlowState.creditsByRequestId.set(route.requestId, availableCredits);

      const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId) ?? [];
      while (availableCredits > 0 && buffered.length > 0) {
        const chunk = buffered.shift();
        if (!chunk) {
          break;
        }
        relayStreamFlowState.totalBufferedChunks = Math.max(0, relayStreamFlowState.totalBufferedChunks - 1);
        emitToConsumer(
          route.consumerSocketId,
          socketEvents.relayRpcChunk,
          encodePayloadFrame(chunk, { requestId: route.requestId }),
        );
        relayMetrics.chunksForwarded += 1;

        const streamIdForAudit = toRequestId(chunk.stream_id);
        const relayRoute = getRelayRequestRoute(route.requestId);
        if (relayRoute) {
          void recordSocketAuditEvent({
            eventType: socketEvents.relayRpcChunk,
            actorSocketId: route.agentSocketId,
            direction: "agent_to_consumer",
            conversationId: relayRoute.conversationId,
            agentId: relayRoute.agentId,
            requestId: route.requestId,
            ...(streamIdForAudit ? { streamId: streamIdForAudit } : {}),
          });
        }

        availableCredits -= 1;
      }

      relayStreamFlowState.bufferedChunksByRequestId.set(route.requestId, buffered);
      relayStreamFlowState.creditsByRequestId.set(route.requestId, Math.max(0, availableCredits));

      if (buffered.length === 0) {
        const pendingComplete = relayStreamFlowState.pendingCompleteByRequestId.get(route.requestId);
        if (pendingComplete) {
          emitToConsumer(
            route.consumerSocketId,
            socketEvents.relayRpcComplete,
            encodePayloadFrame(pendingComplete, { requestId: route.requestId }),
          );

          const relayRoute = getRelayRequestRoute(route.requestId);
          const streamIdForAudit = toRequestId(pendingComplete.stream_id);
          if (relayRoute) {
            void recordSocketAuditEvent({
              eventType: socketEvents.relayRpcComplete,
              actorSocketId: route.agentSocketId,
              direction: "agent_to_consumer",
              conversationId: relayRoute.conversationId,
              agentId: relayRoute.agentId,
              requestId: route.requestId,
              ...(streamIdForAudit ? { streamId: streamIdForAudit } : {}),
            });
          }

          relayStreamFlowState.pendingCompleteByRequestId.delete(route.requestId);
          removeRelayRequestRoute(route.requestId);
          const activeRoute = getActiveStreamRouteByRequestId(route.requestId);
          if (activeRoute) {
            removeActiveStreamRoute(activeRoute);
          }
        }
      }
    }

    return {
      requestId: route.requestId,
      streamId,
      windowSize,
    };
  };
};
