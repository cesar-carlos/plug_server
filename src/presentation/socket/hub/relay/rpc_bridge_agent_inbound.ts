import { recordSocketAuditEvent } from "../../../../application/services/socket_audit.service";
import {
  attachServerTimingsToResponse,
  buildServerTimingsEnvelope,
} from "../../../../application/services/server_timings_envelope";
import {
  noteRelayBodyIdEcho,
  noteRelayFastPathStreamInadvertent,
  observeRelayBodyIdEchoOverhead,
} from "../../../../shared/metrics/socket_consumer.metrics";
import { env } from "../../../../shared/config/env";
import { HUB_MAX_BATCH_SIZE } from "../../../../shared/constants/agent_transport_contract";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { serviceUnavailable } from "../../../../shared/errors/http_errors";
import { noteAgentHealthRpcResponse } from "../../../../shared/metrics/socket_agent.metrics";
import { logger } from "../../../../shared/utils/logger";
import {
  decodePayloadFrameAsync,
  type PayloadFrameEnvelope,
} from "../../../../shared/utils/payload_frame";
import {
  enqueueRelayOutbound,
  encodeRelayOutboundFrame,
  encodeRelayOutboundFrameFromBytes,
  markRelayOutboundForceGzip,
} from "./relay_outbound_queue";
import { isRecord, toRequestId } from "../../../../shared/utils/rpc_types";
import type { ActiveStreamRoute } from "../registries/active_stream_registry";
import {
  getActiveStreamRouteCount,
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
  relayMetrics,
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
import { setRelayStreamFlowCredits } from "./relay_stream_flow_state";
import {
  findRelayRequestRouteForAgentSocket,
  getRelayRequestRoute,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import { createRelayStreamHandlers, type EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import { extractStreamIdFromRpcResponse, pickResponseIds } from "./rpc_bridge_command_helpers";
import { createOrderedStreamInboundQueue } from "./ordered_stream_inbound_queue";
import { startRestStreamMaterialization } from "./rest_stream_materialize_handler";
import { createRelayFailFastEmitters } from "./rpc_bridge_relay_fail_fast";
import {
  observeRelayRouteOutcome,
  persistRelayIdempotentResponseFrame,
  resolveOutboundBodyId,
} from "./rpc_bridge_relay_route_helpers";

const relayMaxActiveStreams = env.socketRelayMaxActiveStreams;

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
              registerAgentFailure(pendingRequest.agentId);
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

        registerAgentSuccess(pendingRequest.agentId);
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

      const relayRoute = findRelayRequestRouteForAgentSocket(candidateIds, socketId);

      if (!relayRoute) {
        return;
      }
      if (relayRoute.timedOut === true) {
        if (logger.isLevelEnabled("debug")) {
          logger.debug("relay_late_response_ignored_after_timeout", {
            requestId: relayRoute.requestId,
            socketId,
          });
        }
        return;
      }

      relayRoute.latencyTrace?.markInboundArrival(inboundSyncStart);
      relayRoute.latencyTrace?.recordInboundDecodeMs(decodeMs);

      const responseId = relayRoute.requestId;

      observeAgentLatency(relayRoute.agentId, Date.now() - relayRoute.createdAtMs);
      registerAgentSuccess(relayRoute.agentId);
      clearTimeout(relayRoute.timeoutHandle);
      conversationRegistry.touchInternal(relayRoute.conversationId);

      if (streamId && relayRoute.fastPath === true) {
        // Fast-path is intended for unary RPCs only — but the determination
        // whether a request will stream lives on the agent side. Log + count
        // here so SREs can spot consumers that set `fastPath: true` for
        // streaming-capable methods. The request still proceeds normally;
        // the consumer just may not have the `requestId` mapping that
        // `relay:rpc.accepted` would have provided.
        noteRelayFastPathStreamInadvertent();
        if (logger.isLevelEnabled("warn")) {
          logger.warn("relay_fast_path_with_stream_response", {
            requestId: responseId,
            conversationId: relayRoute.conversationId,
            clientRequestId: relayRoute.clientRequestId ?? null,
            method: relayRoute.jsonRpcMethod ?? null,
            streamId,
          });
        }
      }

      if (streamId) {
        const effectivePolicy = agentRegistry.resolveEffectiveDispatchPolicy(relayRoute.agentId);
        const exceededAgentStreamLimit =
          countOpenStreamRoutesForAgent(socketId) >= effectivePolicy.maxConcurrentStreams;
        const exceededHubRelayStreamLimit = getActiveStreamRouteCount() >= relayMaxActiveStreams;
        if (exceededAgentStreamLimit || exceededHubRelayStreamLimit) {
          const limitMessage = exceededAgentStreamLimit
            ? `Agent active stream capacity reached (${effectivePolicy.maxConcurrentStreams})`
            : `Relay active stream capacity reached (${relayMaxActiveStreams})`;
          const errorCode = exceededAgentStreamLimit
            ? "AGENT_STREAM_CAPACITY_REACHED"
            : "RELAY_STREAM_CAPACITY_REACHED";
          const outboundBodyId = resolveOutboundBodyId(responseId, relayRoute);
          if (outboundBodyId !== responseId) {
            noteRelayBodyIdEcho();
          }
          const errorPayload = {
            jsonrpc: "2.0",
            id: outboundBodyId,
            error: {
              code: -32000,
              message: limitMessage,
              data: {
                code: errorCode,
                retryable: true,
              },
            },
          };
          relayRoute.latencyTrace?.finalizeOnce({
            outcome: "error",
            httpStatus: 503,
            errorCode,
          });
          observeRelayRouteOutcome(relayRoute, "error");
          enqueueRelayOutbound(responseId, async () => {
            try {
              const frame = await encodeRelayOutboundFrame(errorPayload, responseId);
              emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, frame);
            } finally {
              const existingStream = getActiveStreamRouteByRequestId(responseId);
              if (existingStream && existingStream.agentSocketId === socketId) {
                removeActiveStreamRoute(existingStream);
              }
              removeRelayRequestRoute(responseId);
            }
          });
          return;
        }
        relayRoute.latencyTrace?.markRelayStreamOpenWall();
        upsertActiveStreamRoute({
          requestId: responseId,
          agentSocketId: socketId,
          streamHandlers: createRelayStreamHandlers(relayRoute, emitToConsumer),
          streamId,
        });
        relayRoute.releaseAgentDispatchSlot?.();
        relayMetrics.streamDispatchSlotsReleasedOnOpen += 1;
        setRelayStreamFlowCredits(responseId, 0);
      }

      enqueueRelayOutbound(responseId, async () => {
        let forwardedResponse = false;
        try {
          // Hot-path bypass: forward the agent's already-encoded bytes
          // verbatim when no payload mutation is needed. Skips one JSON
          // parse-stringify round-trip per response (significant on
          // streaming flows). Conditions:
          //   - consumer did NOT opt into `meta.serverTimings` (would mutate)
          //   - we do NOT need to rewrite the JSON-RPC `body.id` back to the
          //     consumer's original id (JSON-RPC 2.0 §5 / fast-path requirement,
          //     see `docs/plug_agente/01_relay_body_id_echo.md`)
          //   - the response is NOT a stream open (already short-circuited
          //     above via `streamId`-driven path; we are in the unary leg
          //     when reaching this block)
          const shouldAttachServerTimings =
            relayRoute.requestServerTimings === true &&
            relayRoute.latencyTrace !== undefined;
          // The hub overwrites `body.id` with its internal `requestId` before
          // dispatching to the agent (so `RpcRequestGuard` / `rpc:request_ack`
          // keep working against legacy agents). On the way out we restore
          // the consumer's `client_request_id` so the JSON-RPC response is
          // routable end-to-end without relying on `relay:rpc.accepted`
          // (required by `fastPath: true`).
          const shouldEchoClientBodyId =
            relayRoute.clientRequestId !== undefined &&
            relayRoute.clientRequestId !== responseId;
          const canBypassReencode = !shouldAttachServerTimings && !shouldEchoClientBodyId;

          let responseFrame: PayloadFrameEnvelope;
          if (canBypassReencode) {
            responseFrame = encodeRelayOutboundFrameFromBytes(decoded.decodedBytes, responseId, {
              inboundCmp: decoded.frame.cmp,
            });
          } else {
            // Measure the wall-clock cost of the re-encode path (vs bypass)
            // only when the cause is the body.id echo. If `shouldAttachServerTimings`
            // is what forced the re-encode, attribute the cost to that
            // pathway instead — bodyIdEcho overhead must reflect only its
            // marginal contribution to ops decisions about Option A.
            const reencodeStart = shouldEchoClientBodyId ? performance.now() : 0;
            const decodedResponse = toRecord(decoded.data);
            const baseOutboundResponse =
              decoded.frame.cmp === "gzip" && decodedResponse
                ? markRelayOutboundForceGzip(decodedResponse)
                : decoded.data;
            if (shouldEchoClientBodyId && isRecord(baseOutboundResponse)) {
              baseOutboundResponse.id = relayRoute.clientRequestId;
              if (logger.isLevelEnabled("debug")) {
                logger.debug("relay_body_id_rewritten", {
                  requestId: responseId,
                  clientRequestId: relayRoute.clientRequestId,
                  jsonRpcMethod: relayRoute.jsonRpcMethod ?? null,
                  conversationId: relayRoute.conversationId,
                });
              }
            }
            // Opt-in `meta.serverTimings`: capture the snapshot just before
            // encoding so the values reflect the forwarder's contribution too.
            // For the dedup-replayed path the cached frame keeps the original
            // request's timings — by design (see `server_timings_envelope.ts`).
            const outboundResponse =
              shouldAttachServerTimings && isRecord(baseOutboundResponse)
                ? attachServerTimingsToResponse(
                    baseOutboundResponse,
                    buildServerTimingsEnvelope(relayRoute.latencyTrace!),
                  )
                : baseOutboundResponse;
            responseFrame = await encodeRelayOutboundFrame(outboundResponse, responseId);
            if (shouldEchoClientBodyId) {
              observeRelayBodyIdEchoOverhead(performance.now() - reencodeStart);
            }
          }
          const tRelayForward = performance.now();
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, responseFrame);
          forwardedResponse = true;
          if (relayRoute.jsonRpcMethod === "agent.getHealth") {
            noteAgentHealthRpcResponse(decoded.data);
          }
          relayRoute.latencyTrace?.addPhaseMs(
            "relay_forward_to_consumer_ms",
            performance.now() - tRelayForward,
          );
          relayMetrics.responsesForwarded += 1;

          if (relayRoute.clientRequestId) {
            const waiters = persistRelayIdempotentResponseFrame(relayRoute, responseFrame);
            if (waiters && waiters.length > 0) {
              for (const waiterSocketId of waiters) {
                if (waiterSocketId === relayRoute.consumerSocketId) {
                  continue;
                }
                emitToConsumer(waiterSocketId, socketEvents.relayRpcResponse, responseFrame);
                relayMetrics.responsesForwarded += 1;
              }
            }
          }

          void recordSocketAuditEvent({
            eventType: socketEvents.relayRpcResponse,
            actorSocketId: socketId,
            direction: "agent_to_consumer",
            conversationId: relayRoute.conversationId,
            agentId: relayRoute.agentId,
            requestId: responseId,
            ...(streamId ? { streamId } : {}),
          });

          if (!streamId) {
            relayRoute.latencyTrace?.recordPendingResolveEnd();
            relayRoute.latencyTrace?.finalizeOnce({ outcome: "success" });
            observeRelayRouteOutcome(relayRoute, "success");
          }
        } catch (error: unknown) {
          relayRoute.latencyTrace?.finalizeOnce({
            outcome: "error",
            httpStatus: 503,
            errorCode: "BRIDGE_OUTBOUND_PROCESSING_FAILED",
          });
          observeRelayRouteOutcome(relayRoute, "error");
          throw error;
        } finally {
          if (streamId && forwardedResponse) {
            return;
          }
          const existingStream = getActiveStreamRouteByRequestId(responseId);
          if (existingStream && existingStream.agentSocketId === socketId) {
            removeActiveStreamRoute(existingStream);
          }
          removeRelayRequestRoute(responseId);
        }
      });
    })().catch((error: unknown) => {
      if (!ackInvoked) {
        fireAck();
      }
      failFastUnexpectedAgentResponseError(socketId, rawPayload, error);
    });
  };

  const handleAgentRpcChunk = (socketId: string, rawPayload: unknown): void => {
    enqueueOrderedStreamInbound(socketId, async () => {
      const tDecode = performance.now();
      const result = await decodePayloadFrameAsync(rawPayload);
      observeRelayFrameDecode(performance.now() - tDecode);
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcChunk,
          socketId,
          reason: result.error.message,
        });
        failFastInvalidAgentStreamFrame(
          socketEvents.rpcChunk,
          socketId,
          rawPayload,
          result.error.message,
        );
        return;
      }

      const contractValidation = validateAgentInboundContract({
        eventName: socketEvents.rpcChunk,
        payload: result.value.data,
        socketId,
      });
      if (!contractValidation.shouldProcess) {
        const reason = `Inbound contract invalid: ${contractValidation.message}`;
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcChunk,
          socketId,
          reason,
        });
        failFastInvalidAgentStreamFrame(socketEvents.rpcChunk, socketId, rawPayload, reason);
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }
      if (result.value.frame.cmp === "gzip") {
        markRelayOutboundForceGzip(data);
      }

      const route = resolveActiveStreamRoute(socketId, data);
      if (!route) {
        return;
      }

      if (route.conversationId) {
        conversationRegistry.touchInternal(route.conversationId);
      }

      try {
        route.onChunk(data, streamChunkMetadataFromPayloadFrame(result.value.frame));
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
      const tDecode = performance.now();
      const result = await decodePayloadFrameAsync(rawPayload);
      observeRelayFrameDecode(performance.now() - tDecode);
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcComplete,
          socketId,
          reason: result.error.message,
        });
        failFastInvalidAgentStreamFrame(
          socketEvents.rpcComplete,
          socketId,
          rawPayload,
          result.error.message,
        );
        return;
      }

      const contractValidation = validateAgentInboundContract({
        eventName: socketEvents.rpcComplete,
        payload: result.value.data,
        socketId,
      });
      if (!contractValidation.shouldProcess) {
        const reason = `Inbound contract invalid: ${contractValidation.message}`;
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcComplete,
          socketId,
          reason,
        });
        failFastInvalidAgentStreamFrame(socketEvents.rpcComplete, socketId, rawPayload, reason);
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }
      if (result.value.frame.cmp === "gzip") {
        markRelayOutboundForceGzip(data);
      }

      const route = resolveActiveStreamRoute(socketId, data);
      if (!route) {
        return;
      }

      if (route.conversationId) {
        conversationRegistry.touchInternal(route.conversationId);
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

  const handleAgentRpcAck = (socketId: string, rawPayload: unknown): void => {
    void decodePayloadFrameAsync(rawPayload).then((result) => {
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcRequestAck,
          socketId,
          reason: result.error.message,
        });
        return;
      }

      const contractValidation = validateAgentInboundContract({
        eventName: socketEvents.rpcRequestAck,
        payload: result.value.data,
        socketId,
      });
      if (!contractValidation.shouldProcess) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcRequestAck,
          socketId,
          reason: `Inbound contract invalid: ${contractValidation.message}`,
        });
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }

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
          const frame = await encodeRelayOutboundFrame(data, requestId);
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcRequestAck, frame);
        });
      }
    });
  };

  const handleAgentBatchAck = (socketId: string, rawPayload: unknown): void => {
    void decodePayloadFrameAsync(rawPayload).then((result) => {
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcBatchAck,
          socketId,
          reason: result.error.message,
        });
        return;
      }

      const contractValidation = validateAgentInboundContract({
        eventName: socketEvents.rpcBatchAck,
        payload: result.value.data,
        socketId,
      });
      if (!contractValidation.shouldProcess) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcBatchAck,
          socketId,
          reason: `Inbound contract invalid: ${contractValidation.message}`,
        });
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }
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
