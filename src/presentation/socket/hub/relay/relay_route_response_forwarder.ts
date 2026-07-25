import { recordSocketAuditEvent } from "../../../../application/services/socket_audit.service";
import {
  attachServerTimingsToResponse,
  buildServerTimingsEnvelope,
} from "../../../../application/services/server_timings_envelope";
import { env } from "../../../../shared/config/env";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { maybeRecordAgentHealthPiggyback } from "../../../../application/services/agent_health_piggyback.service";
import { noteAgentHealthRpcResponse } from "../../../../shared/metrics/socket_agent.metrics";
import {
  noteRelayBodyIdEcho,
  noteRelayFastPathStreamInadvertent,
  noteRelayLateResponseAfterTimeout,
  noteRelayOutboundJobFailureNotified,
  observeRelayBodyIdEchoOverhead,
} from "../../../../shared/metrics/socket_consumer.metrics";
import { noteRelayLateResponseIfTimedOut } from "./relay_timeout_tombstone";
import { trySettleRelayRoute } from "./relay_route_settlement";
import { logger } from "../../../../shared/utils/logger";
import { isRecord, toRequestId } from "../../../../shared/utils/rpc_types";
import type {
  DecodedPayloadFrame,
  PayloadFrameEnvelope,
} from "../../../../shared/utils/payload_frame";
import { agentRegistry } from "../registries/agent_registry";
import {
  countOpenStreamRoutesForAgent,
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteCount,
  removeActiveStreamRoute,
  upsertActiveStreamRoute,
} from "../registries/active_stream_registry";
import { conversationRegistry } from "../registries/conversation_registry";
import {
  findRelayRequestRouteForAgentSocket,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import {
  observeAgentLatency,
  registerAgentSuccess,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import {
  enqueueRelayOutbound,
  encodeRelayOutboundFrame,
  encodeRelayOutboundFrameFromBytesAsync,
  encodeRelayOutboundFrameFromPreencodedWireAsync,
  markRelayOutboundForceGzip,
} from "./relay_outbound_queue";
import { setRelayStreamFlowCredits } from "./relay_stream_flow_state";
import { createRelayStreamHandlers, type EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import {
  observeRelayRouteOutcome,
  persistRelayIdempotentResponseFrame,
  resolveOutboundBodyId,
} from "./rpc_bridge_relay_route_helpers";

const relayMaxActiveStreams = env.socketRelayMaxActiveStreams;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export interface ForwardRelayRouteResponseParams {
  readonly socketId: string;
  readonly candidateIds: readonly string[];
  readonly decoded: DecodedPayloadFrame;
  readonly streamId: string | null;
  readonly inboundSyncStart: number;
  readonly decodeMs: number;
  readonly emitToConsumer: EmitToConsumerFn;
}

/**
 * Forwards a decoded agent `rpc:response` to the relay consumer that owns the
 * matching request route. Handles late/timed-out routes, stream-open capacity
 * limits, opening the active stream route, and the unary outbound forward
 * (with the hot-path byte bypass, JSON-RPC `body.id` echo, optional
 * `meta.serverTimings`, idempotent replay fan-out, and audit).
 *
 * Extracted verbatim from `handleAgentRpcResponse` so the relay forwarding
 * path is an isolated unit depending only on `emitToConsumer` plus shared
 * route helpers and registries.
 */
export const forwardRelayRouteResponse = (params: ForwardRelayRouteResponseParams): void => {
  const { socketId, candidateIds, decoded, streamId, inboundSyncStart, decodeMs, emitToConsumer } =
    params;

  const relayRoute = findRelayRequestRouteForAgentSocket(candidateIds, socketId);

  if (!relayRoute) {
    noteRelayLateResponseIfTimedOut(candidateIds);
    return;
  }
  if (relayRoute.timedOut === true || relayRoute.settled === true) {
    noteRelayLateResponseAfterTimeout();
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
  registerAgentSuccess(relayRoute.agentId, "relay");
  clearTimeout(relayRoute.timeoutHandle);
  conversationRegistry.touchInternalDebounced(relayRoute.conversationId);

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
      if (!trySettleRelayRoute(relayRoute)) {
        return;
      }
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
      agentId: relayRoute.agentId,
      streamHandlers: createRelayStreamHandlers(relayRoute, emitToConsumer),
      streamId,
    });
    relayRoute.releaseAgentDispatchSlot?.();
    relayMetrics.streamDispatchSlotsReleasedOnOpen += 1;
    setRelayStreamFlowCredits(responseId, 0);
  }

  if (!trySettleRelayRoute(relayRoute)) {
    noteRelayLateResponseAfterTimeout();
    return;
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
        relayRoute.requestServerTimings === true && relayRoute.latencyTrace !== undefined;
      // The hub overwrites `body.id` with its internal `requestId` before
      // dispatching to legacy agents (so `RpcRequestGuard` / `rpc:request_ack`
      // keep working). On the way out we restore the consumer's
      // `client_request_id` when the agent echoed the hub UUID (Opcao B).
      // When `clientRequestIdEcho` is negotiated the agent already returns
      // `body.id == client_request_id`, so no rewrite is needed (Opcao A).
      const decodedResponseRecord = toRecord(decoded.data);
      const decodedBodyId = toRequestId(decodedResponseRecord?.id);
      const agentPhaseTimingsNegotiated = relayRoute.agentPhaseTimingsNegotiated === true;
      const responseMeta = decodedResponseRecord?.meta;
      const responseHasAgentPhases =
        isRecord(responseMeta) &&
        (responseMeta.agent_phases !== undefined || responseMeta.agentPhases !== undefined);
      // ADR 0012: forward only when consumer opted into timings AND agent negotiated.
      const mustStripAgentPhases =
        responseHasAgentPhases &&
        (relayRoute.requestServerTimings !== true || !agentPhaseTimingsNegotiated);
      const shouldEchoClientBodyId =
        relayRoute.clientRequestId !== undefined && decodedBodyId !== relayRoute.clientRequestId;
      const canBypassReencode =
        !shouldAttachServerTimings && !shouldEchoClientBodyId && !mustStripAgentPhases;

      let responseFrame: PayloadFrameEnvelope;
      if (canBypassReencode) {
        responseFrame =
          decoded.frame.cmp === "gzip" && Buffer.isBuffer(decoded.frame.payload)
            ? await encodeRelayOutboundFrameFromPreencodedWireAsync(
                {
                  originalSize: decoded.frame.originalSize,
                  wireBytes: decoded.frame.payload,
                  cmp: "gzip",
                },
                responseId,
              )
            : await encodeRelayOutboundFrameFromBytesAsync(decoded.decodedBytes, responseId, {
                inboundCmp: decoded.frame.cmp,
              });
      } else {
        // Measure the wall-clock cost of the re-encode path (vs bypass)
        // only when the cause is the body.id echo. If `shouldAttachServerTimings`
        // is what forced the re-encode, attribute the cost to that
        // pathway instead — bodyIdEcho overhead must reflect only its
        // marginal contribution to ops decisions about Option A.
        const reencodeStart = shouldEchoClientBodyId ? performance.now() : 0;
        const decodedResponse = decodedResponseRecord ?? toRecord(decoded.data);
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
        if (
          mustStripAgentPhases &&
          isRecord(baseOutboundResponse) &&
          isRecord(baseOutboundResponse.meta)
        ) {
          const gatedMeta = { ...baseOutboundResponse.meta };
          delete gatedMeta.agent_phases;
          delete gatedMeta.agentPhases;
          baseOutboundResponse.meta = gatedMeta;
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
      } else if (relayRoute.healthPiggybackNegotiated === true) {
        const negotiatedFreshnessThresholdMs = agentRegistry.getHealthPiggybackFreshnessThresholdMs(
          relayRoute.agentId,
        );
        if (negotiatedFreshnessThresholdMs !== null) {
          maybeRecordAgentHealthPiggyback({
            agentId: relayRoute.agentId,
            negotiatedFreshnessThresholdMs,
            rpcBody: decoded.data,
          });
        }
      }
      relayRoute.latencyTrace?.addPhaseMs(
        "relay_forward_to_consumer_ms",
        performance.now() - tRelayForward,
      );
      relayMetrics.responsesForwarded += 1;

      if (relayRoute.clientRequestId) {
        const waiters = persistRelayIdempotentResponseFrame(relayRoute, responseFrame);
        if (waiters && waiters.size > 0) {
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
      // Only emit a synthetic error when the real response has not been sent yet.
      // When forwardedResponse=true the consumer already received the response; emitting
      // here would double-deliver and violate the JSON-RPC single-response contract.
      if (!forwardedResponse) {
        try {
          const errorPayload = {
            jsonrpc: "2.0",
            id: resolveOutboundBodyId(responseId, relayRoute),
            error: {
              code: -32603,
              message: "internal error",
              data: {
                code: "BRIDGE_OUTBOUND_PROCESSING_FAILED",
                retryable: true,
              },
            },
          };
          const frame = await encodeRelayOutboundFrame(errorPayload, responseId);
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, frame);
          noteRelayOutboundJobFailureNotified();
        } catch {
          // Best-effort: consumer may still hang if synthetic error emit fails.
        }
      }
      throw error;
    } finally {
      // For a successful relay stream open (streamId present and response delivered), the
      // active stream route and relay route must stay alive until the stream completes —
      // do not clean them up here. All other outcomes (pre-emit failure, unary response,
      // or no stream) require immediate cleanup so resources are not leaked.
      if (!streamId || !forwardedResponse) {
        const existingStream = getActiveStreamRouteByRequestId(responseId);
        if (existingStream && existingStream.agentSocketId === socketId) {
          removeActiveStreamRoute(existingStream);
        }
        removeRelayRequestRoute(responseId);
      }
    }
  });
};
