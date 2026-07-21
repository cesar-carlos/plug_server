import { HUB_MAX_BATCH_SIZE } from "../../../../shared/constants/agent_transport_contract";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { serviceUnavailable } from "../../../../shared/errors/http_errors";
import { logger } from "../../../../shared/utils/logger";
import {
  decodePayloadFrameAsync,
  type DecodedPayloadFrame,
} from "../../../../shared/utils/payload_frame";
import {
  enqueueRelayOutbound,
  encodeRelayOutboundFrame,
  encodeRelayOutboundFrameFromBytesAsync,
  markRelayOutboundForceGzip,
} from "./relay_outbound_queue";
import { isRecord, toRequestId } from "../../../../shared/utils/rpc_types";
import type { ActiveStreamRoute } from "../registries/active_stream_registry";
import {
  countOpenStreamRoutesForAgent,
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
  resolveActiveStreamRoute,
  upsertActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  logRpcFrameDecodeFailure,
  observeRelayFrameDecode,
  observeAgentLatency,
  registerAgentFailure,
  registerAgentSuccess,
} from "./bridge_relay_health_metrics";
import { agentRegistry } from "../registries/agent_registry";
import { validateAgentInboundContract } from "../handshake/agent_inbound_contract_validation";
import { conversationRegistry } from "../registries/conversation_registry";
import {
  clearRestPendingRequest,
  findRestPendingRequestByIds,
  getRestPendingRequestByCorrelationId,
} from "../registries/rest_pending_requests";
import { streamChunkMetadataFromPayloadFrame } from "./stream_chunk_metadata";
import { getRelayRequestRoute } from "../registries/relay_request_registry";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import { extractStreamIdFromRpcResponse, pickResponseIds } from "./rpc_bridge_command_helpers";
import { createOrderedStreamInboundQueue } from "./ordered_stream_inbound_queue";
import { startRestStreamMaterialization } from "./rest_stream_materialize_handler";
import { forwardRelayRouteResponse } from "./relay_route_response_forwarder";
import { createRelayFailFastEmitters } from "./rpc_bridge_relay_fail_fast";

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export interface RpcBridgeAgentInboundDeps {
  readonly emitToConsumer: EmitToConsumerFn;
  readonly emitRpcStreamPullForRoute: (route: ActiveStreamRoute, windowSize: number) => void;
}

export type RpcBridgeAgentInboundHandlers = {
  /**
   * Optional `ack` is the Socket.IO acknowledgment callback when the agent uses
   * `emitWithAck` / `emitWithAckAsync` on `rpc:response` (plug_agente delivery guarantees).
   */
  readonly handleAgentRpcResponse: (
    socketId: string,
    rawPayload: unknown,
    ack?: () => void,
  ) => void;
  readonly handleAgentRpcChunk: (socketId: string, rawPayload: unknown) => void;
  readonly handleAgentRpcComplete: (socketId: string, rawPayload: unknown) => void;
  readonly handleAgentRpcAck: (socketId: string, rawPayload: unknown) => void;
  readonly handleAgentBatchAck: (socketId: string, rawPayload: unknown) => void;
  readonly cleanupSocketInboundState: (socketId: string) => void;
  readonly resetInboundState: () => void;
};

export const createRpcBridgeAgentInboundHandlers = (
  deps: RpcBridgeAgentInboundDeps,
): RpcBridgeAgentInboundHandlers => {
  const { emitToConsumer, emitRpcStreamPullForRoute } = deps;
  const orderedStreamInbound = createOrderedStreamInboundQueue();
  const enqueueOrderedStreamInbound = orderedStreamInbound.enqueue;

  const {
    failFastUnexpectedAgentResponseError,
    failFastInvalidAgentResponseFrame,
    failFastInvalidAgentStreamFrame,
    rejectRelayBatchResponse,
  } = createRelayFailFastEmitters({ emitToConsumer });

  const handleAgentRpcResponse = (
    socketId: string,
    rawPayload: unknown,
    ack?: () => void,
  ): void => {
    const inboundSyncStart = performance.now();
    const decodeStart = performance.now();
    let ackInvoked = false;
    const fireAck = (): void => {
      if (ackInvoked || typeof ack !== "function") {
        return;
      }
      ackInvoked = true;
      try {
        ack();
      } catch {
        /* ignore: consumer disconnected */
      }
    };

    void (async () => {
      const result = await decodePayloadFrameAsync(rawPayload);
      const decodeMs = performance.now() - decodeStart;

      if (!result.ok) {
        fireAck();
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcResponse,
          socketId,
          reason: result.error.message,
        });
        failFastInvalidAgentResponseFrame(socketId, rawPayload, result.error.message);
        return;
      }

      const decoded = result.value;
      const contractValidation = validateAgentInboundContract({
        eventName: socketEvents.rpcResponse,
        payload: decoded.data,
        socketId,
      });
      if (!contractValidation.shouldProcess) {
        fireAck();
        const reason = `Inbound contract invalid: ${contractValidation.message}`;
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcResponse,
          socketId,
          reason,
        });
        failFastInvalidAgentResponseFrame(socketId, rawPayload, reason);
        return;
      }

      if (Array.isArray(decoded.data) && decoded.data.length > HUB_MAX_BATCH_SIZE) {
        fireAck();
        const reason = `rpc:response batch cannot exceed ${HUB_MAX_BATCH_SIZE}`;
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcResponse,
          socketId,
          reason,
        });
        failFastInvalidAgentResponseFrame(socketId, rawPayload, reason);
        return;
      }

      fireAck();

      const frameRequestId = toRequestId(decoded.frame.requestId);
      const responseIds = pickResponseIds(decoded.data);
      const candidateIds = Array.from(
        new Set([...responseIds, ...(frameRequestId ? [frameRequestId] : [])]),
      );

      if (candidateIds.length === 0) {
        return;
      }

      const streamId = extractStreamIdFromRpcResponse(decoded.data);
      const pendingRequest = findRestPendingRequestByIds(socketId, candidateIds);
      if (pendingRequest) {
        pendingRequest.latencyTrace?.markInboundArrival(inboundSyncStart);
        pendingRequest.latencyTrace?.recordInboundDecodeMs(decodeMs);
        const pendingRequestId = pendingRequest.primaryRequestId;
        const deferredRestStream = Boolean(streamId) && pendingRequest.restStreamAggregate === true;

        if (deferredRestStream) {
          startRestStreamMaterialization({
            socketId,
            pendingRequest,
            decoded,
            streamId: streamId as string,
            emitRpcStreamPullForRoute,
          });
          return;
        }

        if (pendingRequest.streamHandlers) {
          if (streamId) {
            const effectivePolicy = agentRegistry.resolveEffectiveDispatchPolicy(
              pendingRequest.agentId,
            );
            if (countOpenStreamRoutesForAgent(socketId) >= effectivePolicy.maxConcurrentStreams) {
              registerAgentFailure(pendingRequest.agentId, "rest");
              clearTimeout(pendingRequest.timeoutHandle);
              clearRestPendingRequest(pendingRequest);
              pendingRequest.reject(
                serviceUnavailable(
                  `Agent active stream capacity reached (${effectivePolicy.maxConcurrentStreams})`,
                ),
              );
              return;
            }
            upsertActiveStreamRoute({
              requestId: pendingRequestId,
              agentSocketId: socketId,
              streamHandlers: pendingRequest.streamHandlers,
              streamId,
            });
            if (logger.isLevelEnabled("debug")) {
              logger.debug("rpc_stream_registered", {
                requestId: pendingRequestId,
                streamId,
                socketId,
              });
            }
          } else {
            const existingStream = getActiveStreamRouteByRequestId(pendingRequestId);
            if (existingStream && existingStream.agentSocketId === socketId) {
              removeActiveStreamRoute(existingStream);
            }
          }
        }

        if (!pendingRequest.acked) {
          logger.info("rpc_response_received_without_ack", {
            requestId: pendingRequestId,
            socketId,
          });
        }

        registerAgentSuccess(pendingRequest.agentId, "rest");
        observeAgentLatency(pendingRequest.agentId, Date.now() - pendingRequest.createdAtMs);
        clearTimeout(pendingRequest.timeoutHandle);
        clearRestPendingRequest(pendingRequest);
        pendingRequest.latencyTrace?.recordPendingResolveEnd();
        pendingRequest.resolve(decoded.data);
      }

      if (Array.isArray(decoded.data)) {
        if (rejectRelayBatchResponse(socketId, candidateIds, inboundSyncStart, decodeMs)) {
          return;
        }
      }

      forwardRelayRouteResponse({
        socketId,
        candidateIds,
        decoded,
        streamId,
        inboundSyncStart,
        decodeMs,
        emitToConsumer,
      });
    })().catch((error: unknown) => {
      if (!ackInvoked) {
        fireAck();
      }
      failFastUnexpectedAgentResponseError(socketId, rawPayload, error);
    });
  };

  /**
   * Shared preamble for the ordered stream-inbound handlers (`rpc:chunk` /
   * `rpc:complete`): decode the frame (with decode-latency metric), validate the
   * inbound contract, normalize to a record, honor gzip force-flag, then resolve
   * the active stream route and touch its conversation. On any short-circuit it
   * runs the matching fail-fast/cleanup and returns `null`.
   */
  const decodeAndResolveStreamRoute = async (
    eventName: Parameters<typeof validateAgentInboundContract>[0]["eventName"],
    socketId: string,
    rawPayload: unknown,
  ): Promise<{
    route: ActiveStreamRoute;
    data: Record<string, unknown>;
    frame: DecodedPayloadFrame["frame"];
    decodedBytes: Buffer;
  } | null> => {
    const tDecode = performance.now();
    const result = await decodePayloadFrameAsync(rawPayload);
    observeRelayFrameDecode(performance.now() - tDecode);
    if (!result.ok) {
      logRpcFrameDecodeFailure({ eventName, socketId, reason: result.error.message });
      failFastInvalidAgentStreamFrame(eventName, socketId, rawPayload, result.error.message);
      return null;
    }

    const contractValidation = validateAgentInboundContract({
      eventName,
      payload: result.value.data,
      socketId,
    });
    if (!contractValidation.shouldProcess) {
      const reason = `Inbound contract invalid: ${contractValidation.message}`;
      logRpcFrameDecodeFailure({ eventName, socketId, reason });
      failFastInvalidAgentStreamFrame(eventName, socketId, rawPayload, reason);
      return null;
    }

    const data = toRecord(result.value.data);
    if (!data) {
      return null;
    }
    if (result.value.frame.cmp === "gzip") {
      markRelayOutboundForceGzip(data);
    }

    const route = resolveActiveStreamRoute(socketId, data);
    if (!route) {
      return null;
    }

    if (route.conversationId) {
      conversationRegistry.touchInternal(route.conversationId);
    }

    return { route, data, frame: result.value.frame, decodedBytes: result.value.decodedBytes };
  };

  const handleAgentRpcChunk = (socketId: string, rawPayload: unknown): void => {
    enqueueOrderedStreamInbound(socketId, async () => {
      const resolved = await decodeAndResolveStreamRoute(
        socketEvents.rpcChunk,
        socketId,
        rawPayload,
      );
      if (!resolved) {
        return;
      }
      const { route, data, frame, decodedBytes } = resolved;
      // Disconnect may have removed the route while this frame was decoding.
      const liveRoute = getActiveStreamRouteByRequestId(route.requestId);
      if (!liveRoute || liveRoute !== route) {
        return;
      }
      try {
        // Forward the agent's original decoded frame bytes verbatim so the
        // relay drain can skip a re-`JSON.stringify` + gzip per chunk. The
        // chunk payload is never mutated on the relay path (no body-id echo /
        // serverTimings — those are response-only), and the inbound `cmp` is
        // preserved so the outbound compression decision is unchanged.
        route.onChunk(data, streamChunkMetadataFromPayloadFrame(frame), {
          bytes: decodedBytes,
          cmp: frame.cmp,
        });
      } catch {
        logger.warn("rpc_stream_chunk_forward_failed", {
          requestId: route.requestId,
          streamId: route.streamId,
          socketId,
        });
      }
    });
  };

  const handleAgentRpcComplete = (socketId: string, rawPayload: unknown): void => {
    enqueueOrderedStreamInbound(socketId, async () => {
      const resolved = await decodeAndResolveStreamRoute(
        socketEvents.rpcComplete,
        socketId,
        rawPayload,
      );
      if (!resolved) {
        return;
      }
      const { route, data } = resolved;
      const liveRoute = getActiveStreamRouteByRequestId(route.requestId);
      if (!liveRoute || liveRoute !== route) {
        return;
      }

      if (route.mode === "relay") {
        route.onComplete(data);
        return;
      }

      try {
        route.onComplete(data);
      } finally {
        removeActiveStreamRoute(route);
      }
    });
  };

  interface DecodedAckFrame {
    readonly data: Record<string, unknown>;
    readonly decodedBytes: Buffer;
    readonly inboundCmp: "none" | "gzip";
  }

  /**
   * Shared preamble for the ack handlers (`rpc:request_ack` / `rpc:batch_ack`):
   * decode the frame, validate the inbound contract and normalize to a record.
   * Unlike the stream preamble it does not fail-fast or resolve a stream route —
   * a bad ack frame is logged and dropped. Returns `null` on any short-circuit.
   */
  const decodeAndValidateAckFrame = async (
    eventName: Parameters<typeof validateAgentInboundContract>[0]["eventName"],
    socketId: string,
    rawPayload: unknown,
  ): Promise<DecodedAckFrame | null> => {
    const result = await decodePayloadFrameAsync(rawPayload);
    if (!result.ok) {
      logRpcFrameDecodeFailure({ eventName, socketId, reason: result.error.message });
      return null;
    }

    const contractValidation = validateAgentInboundContract({
      eventName,
      payload: result.value.data,
      socketId,
    });
    if (!contractValidation.shouldProcess) {
      logRpcFrameDecodeFailure({
        eventName,
        socketId,
        reason: `Inbound contract invalid: ${contractValidation.message}`,
      });
      return null;
    }

    const data = toRecord(result.value.data);
    if (!data) {
      return null;
    }

    return {
      data,
      decodedBytes: result.value.decodedBytes,
      inboundCmp: result.value.frame.cmp,
    };
  };

  const handleAgentRpcAck = (socketId: string, rawPayload: unknown): void => {
    void (async () => {
      const ackFrame = await decodeAndValidateAckFrame(
        socketEvents.rpcRequestAck,
        socketId,
        rawPayload,
      );
      if (!ackFrame) {
        return;
      }
      const { data, decodedBytes, inboundCmp } = ackFrame;

      const requestId = toRequestId(data.request_id);
      if (!requestId) {
        return;
      }

      const pending = getRestPendingRequestByCorrelationId(requestId);
      if (pending && pending.socketId === socketId) {
        pending.acked = true;
        if (pending.ackRetryTimer !== undefined) {
          clearTimeout(pending.ackRetryTimer);
          delete pending.ackRetryTimer;
        }
        if (logger.isLevelEnabled("debug")) {
          logger.debug("rpc_ack_received", { requestId, socketId });
        }
      }

      const relayRoute = getRelayRequestRoute(requestId);
      if (relayRoute && relayRoute.agentSocketId === socketId) {
        relayRoute.acked = true;
        if (relayRoute.ackRetryTimer !== undefined) {
          clearTimeout(relayRoute.ackRetryTimer);
          delete relayRoute.ackRetryTimer;
        }
        enqueueRelayOutbound(requestId, async () => {
          const frame = await encodeRelayOutboundFrameFromBytesAsync(decodedBytes, requestId, {
            inboundCmp,
          });
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcRequestAck, frame);
        });
      }
    })().catch((error: unknown) => {
      logger.warn("rpc_ack_handler_failed", {
        socketId,
        eventName: socketEvents.rpcRequestAck,
        message: error instanceof Error ? error.message : "unknown error",
      });
    });
  };

  const handleAgentBatchAck = (socketId: string, rawPayload: unknown): void => {
    void (async () => {
      const ackFrame = await decodeAndValidateAckFrame(
        socketEvents.rpcBatchAck,
        socketId,
        rawPayload,
      );
      if (!ackFrame) {
        return;
      }
      const { data } = ackFrame;
      if (Array.isArray(data.request_ids) && data.request_ids.length > HUB_MAX_BATCH_SIZE) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcBatchAck,
          socketId,
          reason: `rpc:batch_ack request_ids cannot exceed ${HUB_MAX_BATCH_SIZE}`,
        });
        return;
      }

      const requestIds = Array.isArray(data.request_ids)
        ? Array.from(
            new Set(
              (data.request_ids as unknown[])
                .map((id) => toRequestId(id))
                .filter((id): id is string => id !== null),
            ),
          )
        : [];

      let ackedCount = 0;
      const relayBatchAckByConsumer = new Map<
        string,
        { firstRequestId: string; requestIds: string[] }
      >();
      for (const requestId of requestIds) {
        const pending = getRestPendingRequestByCorrelationId(requestId);
        if (pending && pending.socketId === socketId) {
          pending.acked = true;
          if (pending.ackRetryTimer !== undefined) {
            clearTimeout(pending.ackRetryTimer);
            delete pending.ackRetryTimer;
          }
          ackedCount++;
        }

        const relayRoute = getRelayRequestRoute(requestId);
        if (relayRoute && relayRoute.agentSocketId === socketId) {
          relayRoute.acked = true;
          if (relayRoute.ackRetryTimer !== undefined) {
            clearTimeout(relayRoute.ackRetryTimer);
            delete relayRoute.ackRetryTimer;
          }
          ackedCount++;
          const existing = relayBatchAckByConsumer.get(relayRoute.consumerSocketId);
          if (existing) {
            existing.requestIds.push(requestId);
          } else {
            relayBatchAckByConsumer.set(relayRoute.consumerSocketId, {
              firstRequestId: requestId,
              requestIds: [requestId],
            });
          }
        }
      }
      for (const [consumerSocketId, batch] of relayBatchAckByConsumer.entries()) {
        enqueueRelayOutbound(batch.firstRequestId, async () => {
          const relayBatchAckPayload = {
            request_ids: batch.requestIds,
            ...(typeof data.received_at === "string" ? { received_at: data.received_at } : {}),
          };
          const frame = await encodeRelayOutboundFrame(relayBatchAckPayload, batch.firstRequestId);
          emitToConsumer(consumerSocketId, socketEvents.relayRpcBatchAck, frame);
        });
      }
      if (ackedCount > 0 && logger.isLevelEnabled("debug")) {
        logger.debug("rpc_batch_ack_received", {
          requestIds: requestIds.slice(0, 5),
          ackedCount,
          socketId,
        });
      }
    })().catch((error: unknown) => {
      logger.warn("rpc_ack_handler_failed", {
        socketId,
        eventName: socketEvents.rpcBatchAck,
        message: error instanceof Error ? error.message : "unknown error",
      });
    });
  };

  return {
    handleAgentRpcResponse,
    handleAgentRpcChunk,
    handleAgentRpcComplete,
    handleAgentRpcAck,
    handleAgentBatchAck,
    cleanupSocketInboundState: orderedStreamInbound.cleanup,
    resetInboundState: orderedStreamInbound.reset,
  };
};
