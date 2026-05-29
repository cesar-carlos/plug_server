import { recordSocketAuditEvent } from "../../../../application/services/socket_audit.service";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { serviceUnavailable } from "../../../../shared/errors/http_errors";
import { noteRelayBodyIdEcho } from "../../../../shared/metrics/socket_consumer.metrics";
import { logger } from "../../../../shared/utils/logger";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
  type ActiveStreamRoute,
} from "../registries/active_stream_registry";
import { registerAgentFailure, relayMetrics } from "./bridge_relay_health_metrics";
import { conversationRegistry } from "../registries/conversation_registry";
import {
  clearRestPendingRequest,
  getRestPendingRequestByCorrelationId,
} from "../registries/rest_pending_requests";
import { getRelayStreamForwardedRows } from "./relay_stream_flow_state";
import {
  getRelayRequestRoute,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import {
  createRelayBatchResponseUnsupportedPayload,
  createRelayDecodeFailurePayload,
  createRelayUnexpectedFailurePayload,
} from "./rpc_bridge_relay_error_payloads";
import {
  extractFrameRequestId,
  findRelayRequestRoutesForAgentSocket,
  observeRelayRouteOutcome,
  persistRelayIdempotentResponseFrame,
  resolveOutboundBodyId,
} from "./rpc_bridge_relay_route_helpers";

export interface RelayFailFastEmitters {
  /** Synthesizes a retryable `-32000` error for an unexpected processing failure. */
  readonly failFastUnexpectedAgentResponseError: (
    socketId: string,
    rawPayload: unknown,
    error: unknown,
  ) => void;
  /** Synthesizes a decode-failure error (signature/compression/decoding) for an undecodable `rpc:response`. */
  readonly failFastInvalidAgentResponseFrame: (
    socketId: string,
    rawPayload: unknown,
    reasonMessage: string,
  ) => void;
  /** Emits a terminal stream-error `rpc:complete` for a relay-mode stream route. */
  readonly emitRelayTerminalFailure: (
    route: ActiveStreamRoute,
    socketId: string,
    reasonMessage: string,
  ) => void;
  /** Terminates an active stream when its `rpc:chunk`/`rpc:complete` frame fails to decode. */
  readonly failFastInvalidAgentStreamFrame: (
    eventName: string,
    socketId: string,
    rawPayload: unknown,
    reasonMessage: string,
  ) => void;
  /** Rejects an unsupported batch `rpc:response` per relay route. Returns `true` when routes matched. */
  readonly rejectRelayBatchResponse: (
    socketId: string,
    candidateIds: readonly string[],
    inboundSyncStart: number,
    decodeMs: number,
  ) => boolean;
}

/**
 * Builds the relay "fail-fast" emitters — the synthetic-error paths that resolve
 * a stuck REST pending request / relay route and forward a terminal JSON-RPC
 * error to the consumer when an inbound agent frame is undecodable, unexpected,
 * or unsupported.
 *
 * Extracted from `createRpcBridgeAgentInboundHandlers` (which had grown past
 * 1.3k lines) so these side-effecting error paths form a discrete unit that
 * depends only on `emitToConsumer` plus shared route helpers and registries.
 */
export const createRelayFailFastEmitters = (deps: {
  readonly emitToConsumer: EmitToConsumerFn;
}): RelayFailFastEmitters => {
  const { emitToConsumer } = deps;

  const failFastUnexpectedAgentResponseError = (
    socketId: string,
    rawPayload: unknown,
    error: unknown,
  ): void => {
    const reasonMessage =
      error instanceof Error ? error.message : "Unexpected agent rpc:response processing failure";
    logger.error("agent_rpc_response_processing_failed", {
      socketId,
      message: reasonMessage,
    });

    const requestId = extractFrameRequestId(rawPayload);
    if (!requestId) {
      return;
    }

    const pendingRequest = getRestPendingRequestByCorrelationId(requestId);
    if (pendingRequest && pendingRequest.socketId === socketId) {
      clearTimeout(pendingRequest.timeoutHandle);
      clearRestPendingRequest(pendingRequest);
      const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream, { restMaterialize: "detach" });
      }
      registerAgentFailure(pendingRequest.agentId);
      pendingRequest.reject(serviceUnavailable(reasonMessage));
    }

    const relayRoute = getRelayRequestRoute(requestId);
    if (!relayRoute || relayRoute.agentSocketId !== socketId) {
      return;
    }

    relayRoute.latencyTrace?.finalizeOnce({
      outcome: "error",
      httpStatus: 503,
      errorCode: "BRIDGE_INBOUND_PROCESSING_FAILED",
    });
    const bodyId = resolveOutboundBodyId(requestId, relayRoute);
    if (bodyId !== requestId) {
      noteRelayBodyIdEcho();
    }
    enqueueRelayOutbound(requestId, async () => {
      const frame = await encodeRelayOutboundFrame(
        createRelayUnexpectedFailurePayload(bodyId, reasonMessage),
        requestId,
      );
      emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, frame);
      const existingStream = getActiveStreamRouteByRequestId(requestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream);
      }
      removeRelayRequestRoute(requestId);
    });
  };

  const failFastInvalidAgentResponseFrame = (
    socketId: string,
    rawPayload: unknown,
    reasonMessage: string,
  ): void => {
    const requestId = extractFrameRequestId(rawPayload);
    if (!requestId) {
      return;
    }

    const pendingRequest = getRestPendingRequestByCorrelationId(requestId);
    if (pendingRequest && pendingRequest.socketId === socketId) {
      clearTimeout(pendingRequest.timeoutHandle);
      clearRestPendingRequest(pendingRequest);
      const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream, { restMaterialize: "detach" });
      }
      registerAgentFailure(pendingRequest.agentId);
      pendingRequest.reject(
        serviceUnavailable(`Failed to decode agent rpc:response frame: ${reasonMessage}`),
      );
    }

    const relayRoute = getRelayRequestRoute(requestId);
    if (!relayRoute || relayRoute.agentSocketId !== socketId) {
      return;
    }

    relayRoute.latencyTrace?.finalizeOnce({
      outcome: "error",
      errorCode: "AGENT_FRAME_DECODE_FAILED",
    });
    const bodyId = resolveOutboundBodyId(requestId, relayRoute);
    if (bodyId !== requestId) {
      noteRelayBodyIdEcho();
    }
    enqueueRelayOutbound(requestId, async () => {
      const frame = await encodeRelayOutboundFrame(
        createRelayDecodeFailurePayload(requestId, reasonMessage, bodyId),
        requestId,
      );
      emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, frame);
      const existingStream = getActiveStreamRouteByRequestId(requestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream);
      }
      removeRelayRequestRoute(requestId);
    });
  };

  const emitRelayTerminalFailure = (
    route: ActiveStreamRoute,
    socketId: string,
    reasonMessage: string,
  ): void => {
    const relayRoute = getRelayRequestRoute(route.requestId);
    if (!relayRoute || relayRoute.agentSocketId !== socketId) {
      return;
    }

    relayMetrics.streamTerminalCompletions += 1;
    relayRoute.latencyTrace?.finalizeOnce({
      outcome: "error",
      httpStatus: 503,
      errorCode: "AGENT_STREAM_FRAME_DECODE_FAILED",
    });
    enqueueRelayOutbound(route.requestId, async () => {
      try {
        const terminalPayload: Record<string, unknown> = {
          request_id: route.requestId,
          total_rows: getRelayStreamForwardedRows(route.requestId),
          terminal_status: "error",
          ...(route.streamId ? { stream_id: route.streamId } : {}),
        };
        const frame = await encodeRelayOutboundFrame(terminalPayload, route.requestId);
        emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcComplete, frame);
        void recordSocketAuditEvent({
          eventType: socketEvents.relayRpcComplete,
          actorSocketId: socketId,
          direction: "agent_to_consumer",
          conversationId: relayRoute.conversationId,
          agentId: relayRoute.agentId,
          requestId: route.requestId,
          ...(route.streamId ? { streamId: route.streamId } : {}),
        });
      } finally {
        const existingStream = getActiveStreamRouteByRequestId(route.requestId);
        if (existingStream && existingStream.agentSocketId === socketId) {
          removeActiveStreamRoute(existingStream);
        }
        removeRelayRequestRoute(route.requestId);
        logger.warn("relay_stream_failed_fast", {
          requestId: route.requestId,
          conversationId: relayRoute.conversationId,
          socketId,
          reason: reasonMessage,
        });
      }
    });
  };

  const failFastInvalidAgentStreamFrame = (
    eventName: string,
    socketId: string,
    rawPayload: unknown,
    reasonMessage: string,
  ): void => {
    const requestId = extractFrameRequestId(rawPayload);
    if (!requestId) {
      return;
    }

    const route = getActiveStreamRouteByRequestId(requestId);
    if (!route || route.agentSocketId !== socketId) {
      return;
    }

    const failureMessage = `Failed to decode agent ${eventName} frame: ${reasonMessage}`;
    if (route.restMaterializeState && !route.restMaterializeState.settled) {
      route.restMaterializeState.settled = true;
      clearTimeout(route.restMaterializeState.timeoutHandle);
      registerAgentFailure(route.restMaterializeState.agentId);
      removeActiveStreamRoute(route, { restMaterialize: "detach" });
      route.restMaterializeState.reject(serviceUnavailable(failureMessage));
      return;
    }

    if (route.mode === "relay") {
      emitRelayTerminalFailure(route, socketId, reasonMessage);
      return;
    }

    try {
      route.onComplete({
        request_id: route.requestId,
        total_rows: 0,
        terminal_status: "error",
        ...(route.streamId ? { stream_id: route.streamId } : {}),
      });
    } finally {
      removeActiveStreamRoute(route);
    }
  };

  const rejectRelayBatchResponse = (
    socketId: string,
    candidateIds: readonly string[],
    inboundSyncStart: number,
    decodeMs: number,
  ): boolean => {
    const relayRoutes = findRelayRequestRoutesForAgentSocket(candidateIds, socketId);
    if (relayRoutes.length === 0) {
      return false;
    }

    for (const route of relayRoutes) {
      if (route.timedOut === true) {
        if (logger.isLevelEnabled("debug")) {
          logger.debug("relay_late_batch_response_ignored_after_timeout", {
            requestId: route.requestId,
            socketId,
          });
        }
        continue;
      }

      const requestId = route.requestId;
      route.latencyTrace?.markInboundArrival(inboundSyncStart);
      route.latencyTrace?.recordInboundDecodeMs(decodeMs);
      route.latencyTrace?.finalizeOnce({
        outcome: "error",
        httpStatus: 502,
        errorCode: "RELAY_BATCH_RESPONSE_UNSUPPORTED",
      });
      observeRelayRouteOutcome(route, "error");
      registerAgentFailure(route.agentId);
      clearTimeout(route.timeoutHandle);
      conversationRegistry.touchInternal(route.conversationId);

      const bodyId = resolveOutboundBodyId(requestId, route);
      if (bodyId !== requestId) {
        noteRelayBodyIdEcho();
      }
      enqueueRelayOutbound(requestId, async () => {
        try {
          const frame = await encodeRelayOutboundFrame(
            createRelayBatchResponseUnsupportedPayload(bodyId),
            requestId,
          );
          emitToConsumer(route.consumerSocketId, socketEvents.relayRpcResponse, frame);
          relayMetrics.responsesForwarded += 1;

          const waiters = persistRelayIdempotentResponseFrame(route, frame);
          if (waiters && waiters.length > 0) {
            for (const waiterSocketId of waiters) {
              if (waiterSocketId === route.consumerSocketId) {
                continue;
              }
              emitToConsumer(waiterSocketId, socketEvents.relayRpcResponse, frame);
              relayMetrics.responsesForwarded += 1;
            }
          }

          void recordSocketAuditEvent({
            eventType: socketEvents.relayRpcResponse,
            actorSocketId: socketId,
            direction: "agent_to_consumer",
            conversationId: route.conversationId,
            agentId: route.agentId,
            requestId,
            payload: { errorCode: "RELAY_BATCH_RESPONSE_UNSUPPORTED" },
          });
        } finally {
          const existingStream = getActiveStreamRouteByRequestId(requestId);
          if (existingStream && existingStream.agentSocketId === socketId) {
            removeActiveStreamRoute(existingStream);
          }
          removeRelayRequestRoute(requestId);
        }
      });
    }

    return true;
  };

  return {
    failFastUnexpectedAgentResponseError,
    failFastInvalidAgentResponseFrame,
    emitRelayTerminalFailure,
    failFastInvalidAgentStreamFrame,
    rejectRelayBatchResponse,
  };
};
