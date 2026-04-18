import type { Namespace } from "socket.io";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { badRequest, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { socketEvents } from "../../../shared/constants/socket_events";
import { encodePayloadFrame } from "../../../shared/utils/payload_frame";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { agentRegistry } from "./agent_registry";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
  removeActiveStreamRoute,
} from "./active_stream_registry";
import { relayMetrics } from "./bridge_relay_health_metrics";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import { getRelayRequestRoute, removeRelayRequestRoute } from "./relay_request_registry";
import { addRelayStreamFlowCredits, drainRelayStreamBuffer } from "./relay_stream_flow_state";
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

/**
 * Side-effect-free preview of an `agents:stream_pull` request.
 * Resolves the route and computes the effective `windowSize` so callers can apply
 * quotas / rate limits before invoking `execute()`, which actually emits to the
 * agent and (for relay routes) grants flow credits.
 */
export interface PreparedAgentStreamPull {
  readonly requestId: string;
  readonly streamId: string;
  readonly windowSize: number;
  readonly execute: () => RequestAgentStreamPullResult;
}

export const createPrepareAgentStreamPull = (
  deps: RpcBridgeStreamPullDeps,
): ((input: RequestAgentStreamPullInput) => PreparedAgentStreamPull) => {
  const { getAgentsNamespace, emitToConsumer } = deps;

  return (input: RequestAgentStreamPullInput): PreparedAgentStreamPull => {
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
      throw notFound("Stream route");
    }

    if (route.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Stream route");
    }

    if (input.conversationId && route.conversationId !== input.conversationId) {
      throw notFound("Stream route");
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

    const registeredAgent = agentRegistry.findBySocketId(route.agentSocketId);
    const windowSize = registeredAgent
      ? agentRegistry.resolveStreamPullWindow(
          registeredAgent.agentId,
          defaultStreamWindowSize,
          input.windowSize,
        )
      : typeof input.windowSize === "number" && Number.isFinite(input.windowSize)
        ? Math.max(1, Math.floor(input.windowSize))
        : defaultStreamWindowSize;

    const execute = (): RequestAgentStreamPullResult => {
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
            omitTraceId: true,
          },
        ),
      );

      if (route.mode === "relay") {
        relayMetrics.streamPulls += 1;
        const relayRouteForAudit = getRelayRequestRoute(route.requestId);
        addRelayStreamFlowCredits(route.requestId, windowSize);

        enqueueRelayOutbound(route.requestId, async () => {
          await drainRelayStreamBuffer({
            requestId: route.requestId,
            consumerSocketId: route.consumerSocketId,
            agentSocketId: route.agentSocketId,
            conversationId: relayRouteForAudit?.conversationId ?? "",
            agentId: relayRouteForAudit?.agentId ?? "",
            emitChunk: (frame) =>
              emitToConsumer(route.consumerSocketId, socketEvents.relayRpcChunk, frame),
            emitComplete: (frame) =>
              emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame),
            encodeFrame: (data) => encodeRelayOutboundFrame(data, route.requestId),
            recordAudit: (eventType, extras) => {
              if (relayRouteForAudit) {
                void recordSocketAuditEvent({
                  eventType,
                  actorSocketId: route.agentSocketId,
                  direction: "agent_to_consumer",
                  conversationId: relayRouteForAudit.conversationId,
                  agentId: relayRouteForAudit.agentId,
                  requestId: route.requestId,
                  ...extras,
                });
              }
            },
            onComplete: (_streamId) => {
              const relayRt = getRelayRequestRoute(route.requestId);
              relayRt?.latencyTrace?.finalizeRelayStreamComplete();
              removeRelayRequestRoute(route.requestId);
              const activeRoute = getActiveStreamRouteByRequestId(route.requestId);
              if (activeRoute) {
                removeActiveStreamRoute(activeRoute);
              }
            },
          });
        });
      }

      return {
        requestId: route.requestId,
        streamId,
        windowSize,
      };
    };

    return {
      requestId: route.requestId,
      streamId,
      windowSize,
      execute,
    };
  };
};

export const createRequestAgentStreamPull = (
  deps: RpcBridgeStreamPullDeps,
): ((input: RequestAgentStreamPullInput) => RequestAgentStreamPullResult) => {
  const prepare = createPrepareAgentStreamPull(deps);
  return (input: RequestAgentStreamPullInput): RequestAgentStreamPullResult => {
    return prepare(input).execute();
  };
};
