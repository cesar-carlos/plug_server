import { randomUUID } from "node:crypto";

import type { BridgeLatencyTraceSession } from "../../../../application/services/bridge_latency_trace_builder";
import { inferBridgeCommandMethod } from "../../../../application/services/bridge_latency_trace_builder";
import { observeBridgeRpcMethod } from "../../../../application/services/bridge_rpc_method_metrics.service";
import { env } from "../../../../shared/config/env";
import { AppError } from "../../../../shared/errors/app_error";
import {
  badRequest,
  notFound,
  serviceUnavailable,
  serviceUnavailableWithRetry,
} from "../../../../shared/errors/http_errors";
import type { PayloadFrameCompression } from "../../../../shared/validators/agent_command";
import { socketEvents } from "../../../../shared/constants/socket_events";
import {
  decodePayloadFrameAsync,
  encodePayloadFrameBridge,
  payloadFrameEncodeOptionsFromPreference,
  type PayloadFrameEnvelope,
} from "../../../../shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../../shared/utils/rpc_types";
import { isClientRequestIdEchoNegotiated } from "../../../../shared/constants/transport_extension_negotiation";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import { agentRegistry } from "../registries/agent_registry";
import {
  ensureAgentCircuitClosed,
  logRpcFrameDecodeFailure,
  noteBridgeAckRetryAttempt,
  noteBridgeAckRetryExhausted,
  observeRelayBridgeEncode,
  observeRelayFrameDecode,
  registerAgentFailure,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import { noteRelayBodyIdEcho } from "../../../../shared/metrics/socket_consumer.metrics";
import { encodeRelayOutboundFrame, enqueueRelayOutbound } from "./relay_outbound_queue";
import { conversationRegistry } from "../registries/conversation_registry";
import {
  getRelayIdempotencyMap,
  getOrCreateRelayIdempotencyMap,
  removeRelayIdempotencyEntry,
  setRelayIdempotencyEntry,
} from "../registries/relay_idempotency_store";
import { setRelayStreamFlowCredits, ensureRelayStreamFlowEntry } from "./relay_stream_flow_state";
import { acquireRelayAgentDispatchSlot } from "./relay_agent_dispatch_queue";
import type { RelayRequestRoute } from "../registries/relay_request_registry";
import {
  getRelayPendingRequestCountForConsumer,
  getRelayPendingRequestCountForConversation,
  getRelayRequestRoute,
  registerRelayRequestRoute,
  removeRelayRequestRoute,
  reserveRelayPendingSlot,
} from "../registries/relay_request_registry";
import {
  clampCommandMaxRows,
  resolveOutboundApiVersion,
  sanitizeOutboundRpcMeta,
} from "./rpc_bridge_command_helpers";
import { emitRelayTimeoutResponse, type EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import {
  relayRpcRefundableBadRequest,
  validateAndNormalizeRelayCommand,
  isRelayStreamingCapableCommand,
} from "./relay_command_validation";
import { recordRelayTimeoutTombstone } from "./relay_timeout_tombstone";
import { trySettleRelayRoute } from "./relay_route_settlement";
import { resolveAgentCompressionPreference } from "./relay_compression_preference";
import type {
  PreparedAgentStreamPull,
  RequestAgentStreamPullInput,
  RequestAgentStreamPullResult,
} from "./rpc_bridge_stream_pull";

const relayRequestTimeoutMs = env.socketRelayRequestTimeoutMs;
const relayMaxPendingRequestsPerConversation = env.socketRelayMaxPendingRequestsPerConversation;
const relayMaxPendingRequestsPerConsumer = env.socketRelayMaxPendingRequestsPerConsumer;
const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const isRouteAcked = (route: RelayRequestRoute): boolean => route.acked === true;

export type DispatchRelayRpcInput = {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  /** Hub → agent PayloadFrame gzip for re-encoded `rpc:request` (consumer frame is decoded first). */
  readonly payloadFrameCompression?: PayloadFrameCompression;
  readonly latencyTrace?: BridgeLatencyTraceSession;
  readonly signal?: AbortSignal;
  /**
   * When `true`, consumer requested `meta.serverTimings` on
   * `relay:rpc.response`. Persisted on the route so the inbound forwarder can
   * inject the snapshot before encoding.
   */
  readonly requestServerTimings?: boolean;
  /**
   * When `true`, consumer requested the unary fast-path (skip
   * `relay:rpc.accepted`). The hub MUST refuse the flag for streaming-capable
   * methods to keep the window/credit handshake intact — enforced by the
   * dispatcher itself.
   */
  readonly fastPath?: boolean;
} & (
  | { readonly rawFramePayload: unknown; readonly preDecodedData?: never }
  | { readonly rawFramePayload?: never; readonly preDecodedData: unknown }
);

export interface DispatchRelayRpcResult {
  readonly requestId: string;
  readonly clientRequestId?: string;
  readonly deduplicated?: boolean;
  readonly replayed?: boolean;
  /**
   * `true` when this request was deduplicated against an earlier request with the
   * same `client_request_id` whose response has not yet arrived. The hub will
   * automatically forward the eventual `relay:rpc.response` to this consumer too,
   * so clients should NOT retry — they should keep waiting on the original
   * request id. `replayed` will be `false` when `inFlight` is `true`.
   */
  readonly inFlight?: boolean;
  /**
   * Echoes the consumer's `fastPath` opt-in. When `true`, the handler MUST
   * skip emitting `relay:rpc.accepted`; dedup state is signalled via
   * `relay:rpc.response` instead.
   */
  readonly fastPath?: boolean;
}

export interface RequestRelayStreamPullInput {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly rawFramePayload: unknown;
}

type AgentSocketEmitter = {
  emit: (eventName: string, payload: unknown) => void;
};

export interface RpcBridgeRelayDispatchDeps {
  readonly hasRegisteredAgentSocketBridge: () => boolean;
  readonly findAgentSocketById: (socketId: string) => AgentSocketEmitter | null;
  readonly emitToConsumer: EmitToConsumerFn;
  readonly prepareAgentStreamPull: (input: RequestAgentStreamPullInput) => PreparedAgentStreamPull;
}

/**
 * Side-effect-free preview of a `relay:rpc.stream.pull` request.
 * Decodes the consumer frame, resolves the relay route, and computes the effective
 * `windowSize` so the caller can apply quotas / rate limits before invoking
 * `execute()`, which actually emits the pull to the agent and grants flow credits.
 */
export interface PreparedRelayStreamPull {
  readonly requestId: string;
  readonly streamId: string;
  readonly windowSize: number;
  readonly execute: () => RequestAgentStreamPullResult;
}

export type RpcBridgeRelayDispatchHandlers = {
  readonly dispatchRelayRpcToAgent: (
    input: DispatchRelayRpcInput,
  ) => Promise<DispatchRelayRpcResult>;
  readonly prepareRelayStreamPull: (
    input: RequestRelayStreamPullInput,
  ) => Promise<PreparedRelayStreamPull>;
  readonly requestRelayStreamPull: (
    input: RequestRelayStreamPullInput,
  ) => Promise<RequestAgentStreamPullResult>;
};

export const createRpcBridgeRelayDispatch = (
  deps: RpcBridgeRelayDispatchDeps,
): RpcBridgeRelayDispatchHandlers => {
  const {
    hasRegisteredAgentSocketBridge,
    findAgentSocketById,
    emitToConsumer,
    prepareAgentStreamPull,
  } = deps;

  const dispatchRelayRpcToAgent = async (
    input: DispatchRelayRpcInput,
  ): Promise<DispatchRelayRpcResult> => {
    const assertNotAborted = (): void => {
      if (input.signal?.aborted) {
        throw serviceUnavailable("Consumer socket disconnected before relay dispatch completed");
      }
    };

    assertNotAborted();
    const trace = input.latencyTrace;
    const relayWallStart = performance.now();
    let decodedData: unknown;
    let inboundFrameTraceId: string | null = null;
    if (input.preDecodedData !== undefined) {
      decodedData = input.preDecodedData;
    } else {
      const decoded = await decodePayloadFrameAsync(input.rawFramePayload);
      assertNotAborted();
      const decodeElapsed = performance.now() - relayWallStart;
      trace?.addPhaseMs("consumer_frame_decode_ms", decodeElapsed);
      observeRelayFrameDecode(decodeElapsed);
      if (!decoded.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.relayRpcRequest,
          socketId: input.consumerSocketId,
          reason: decoded.error.message,
        });
        throw relayRpcRefundableBadRequest(decoded.error.message);
      }
      decodedData = decoded.value.data;
      inboundFrameTraceId = toRequestId(decoded.value.frame.traceId);
    }
    const relayPreflightStart = performance.now();

    const { command, normalizedCommand } = validateAndNormalizeRelayCommand(decodedData);

    const conversation = conversationRegistry.findInternalByConversationId(input.conversationId);
    if (!conversation || conversation.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Conversation");
    }
    const effectivePolicy = agentRegistry.resolveEffectiveDispatchPolicy(conversation.agentId);
    const clamped = clampCommandMaxRows(normalizedCommand, effectivePolicy.maxRows);
    const normalizedAndClamped = clamped.command as typeof normalizedCommand;

    if (
      input.fastPath === true &&
      isRelayStreamingCapableCommand(normalizedAndClamped as { method: string; params?: unknown })
    ) {
      throw badRequest("fastPath is not allowed for streaming-capable RPC methods");
    }

    const pendingReservation = reserveRelayPendingSlot(
      conversation.conversationId,
      conversation.consumerSocketId,
    );
    if (!pendingReservation) {
      if (
        getRelayPendingRequestCountForConversation(conversation.conversationId) >=
        relayMaxPendingRequestsPerConversation
      ) {
        throw serviceUnavailable("Relay pending request capacity reached for conversation");
      }
      if (
        getRelayPendingRequestCountForConsumer(conversation.consumerSocketId) >=
        relayMaxPendingRequestsPerConsumer
      ) {
        throw serviceUnavailable("Relay pending request capacity reached for consumer");
      }
      throw serviceUnavailable("Relay pending request capacity reached");
    }

    /**
     * Reservation must be released on every early exit (not-ready, circuit,
     * missing socket, idempotent dedupe). Once `registerRelayRequestRoute`
     * consumes it via `countersReserved: true`, the route owns the counters.
     */
    let pendingReservationConsumed = false;
    try {
      const readiness = agentRegistry.getProtocolReadiness(conversation.agentId);
      if (!readiness.ready) {
        throw serviceUnavailableWithRetry(
          `Agent ${conversation.agentId} protocol negotiation is not ready`,
          readiness.retryAfterMs,
        );
      }

      ensureAgentCircuitClosed(conversation.agentId);

      if (!hasRegisteredAgentSocketBridge()) {
        throw serviceUnavailable("Socket bridge is not initialized");
      }

      const agentSocket = findAgentSocketById(conversation.agentSocketId);
      if (!agentSocket) {
        throw serviceUnavailable("Agent socket is unavailable");
      }

      const cmdRecord = normalizedAndClamped as Record<string, unknown>;
      const clientRequestId = toRequestId(cmdRecord.id);
      const idempotencyMap = clientRequestId
        ? getOrCreateRelayIdempotencyMap(conversation.conversationId)
        : null;
      if (clientRequestId) {
        const existing = idempotencyMap?.get(clientRequestId);
        if (existing && existing.expiresAtMs > Date.now()) {
          relayMetrics.requestsDeduplicated += 1;
          trace?.dismissWithoutPersist();
          if (existing.responseFrame) {
            enqueueRelayOutbound(existing.requestId, async () => {
              emitToConsumer(
                conversation.consumerSocketId,
                socketEvents.relayRpcResponse,
                existing.responseFrame,
              );
            });
            return {
              requestId: existing.requestId,
              clientRequestId,
              deduplicated: true,
              replayed: true,
            };
          }

          // Original request is still in flight. Register this consumer as a
          // pending replay target so that when the response arrives, it is
          // forwarded to this socket too. Avoid duplicates within the list.
          const waiters =
            existing.pendingReplayConsumerSocketIds ??
            (existing.pendingReplayConsumerSocketIds = new Set<string>());
          if (!waiters.has(conversation.consumerSocketId)) {
            waiters.add(conversation.consumerSocketId);
          }
          return {
            requestId: existing.requestId,
            clientRequestId,
            deduplicated: true,
            inFlight: true,
          };
        }
      }

      const requestId = randomUUID();

      if (clientRequestId) {
        const idempotencyResult = setRelayIdempotencyEntry(
          conversation.conversationId,
          clientRequestId,
          {
            requestId,
            expiresAtMs: Date.now() + relayIdempotencyTtlMs,
          },
        );
        if (!idempotencyResult.ok) {
          throw serviceUnavailable(
            idempotencyResult.reason === "global_cap_reached"
              ? "Relay idempotency capacity reached"
              : "Relay idempotency capacity reached for conversation",
          );
        }
      }

      const traceId = inboundFrameTraceId ?? randomUUID();
      const existingMeta = sanitizeOutboundRpcMeta(toRecord(cmdRecord.meta));
      const registeredAgent = agentRegistry.findByAgentId(conversation.agentId);
      const echoClientRequestId =
        clientRequestId != null &&
        registeredAgent != null &&
        isClientRequestIdEchoNegotiated(registeredAgent.capabilities);
      const rpcBodyId = echoClientRequestId ? clientRequestId : requestId;
      const commandPayload: Record<string, unknown> = {
        ...normalizedAndClamped,
        id: rpcBodyId,
        api_version: resolveOutboundApiVersion(cmdRecord),
        meta: {
          ...existingMeta,
          request_id: requestId,
          agent_id: conversation.agentId,
          timestamp: new Date().toISOString(),
          trace_id: traceId,
        },
      };

      trace?.attachDispatchMeta({
        requestId,
        traceId,
        jsonRpcMethod: inferBridgeCommandMethod(command),
        agentId: conversation.agentId,
      });

      const relayCompressionPreference = resolveAgentCompressionPreference({
        preference: input.payloadFrameCompression,
        allowsNoneCompression: effectivePolicy.allowsNoneCompression,
        allowsGzip: effectivePolicy.allowsGzip,
        buildUnsupportedError: () =>
          badRequest("Agent capabilities do not support any advertised PayloadFrame compression"),
      });

      const releaseAgentDispatchSlot = await acquireRelayAgentDispatchSlot(
        conversation.agentId,
        input.signal,
      ).catch((error: unknown) => {
        if (clientRequestId) {
          removeRelayIdempotencyEntry(conversation.conversationId, clientRequestId);
        }
        throw error;
      });

      const timeoutHandle = setTimeout(() => {
        const route = getRelayRequestRoute(requestId);
        if (!route || !trySettleRelayRoute(route)) {
          return;
        }

        route.timedOut = true;
        recordRelayTimeoutTombstone(route.requestId, route.conversationId);
        removeRelayRequestRoute(requestId);
        const existingStream = getActiveStreamRouteByRequestId(requestId);
        if (existingStream) {
          removeActiveStreamRoute(existingStream);
        }
        relayMetrics.requestTimeouts += 1;
        registerAgentFailure(route.agentId);
        if (route.latencyTrace && !route.latencyTrace.isFinalized()) {
          route.latencyTrace.finalizeOnce({
            outcome: "timeout",
            httpStatus: 503,
            errorCode: "RELAY_REQUEST_TIMEOUT",
          });
        }
        if (
          !isRouteAcked(route) &&
          clientRequestId !== null &&
          env.socketAgentAckRetryEnabled &&
          (route.ackRetriesAttempted ?? 0) >= env.socketAgentAckMaxRetries
        ) {
          noteBridgeAckRetryExhausted("relay");
        }
        observeBridgeRpcMethod({
          channel: "relay",
          method: route.jsonRpcMethod ?? "unknown",
          outcome: "timeout",
          elapsedMs: Date.now() - route.createdAtMs,
        });
        emitRelayTimeoutResponse(route, emitToConsumer);
      }, relayRequestTimeoutMs);

      const relayRoute: RelayRequestRoute = {
        requestId,
        conversationId: conversation.conversationId,
        consumerSocketId: conversation.consumerSocketId,
        agentSocketId: conversation.agentSocketId,
        agentId: conversation.agentId,
        jsonRpcMethod: inferBridgeCommandMethod(command),
        timeoutHandle,
        createdAtMs: Date.now(),
        ...(clientRequestId !== null ? { clientRequestId } : {}),
        ...(trace ? { latencyTrace: trace } : {}),
        releaseAgentDispatchSlot,
        ...(input.requestServerTimings === true ? { requestServerTimings: true } : {}),
        ...(input.fastPath === true ? { fastPath: true } : {}),
        acked: false,
        ackRetriesAttempted: 0,
      };

      const scheduleAckRetry = (wireFrame: PayloadFrameEnvelope): void => {
        if (
          !env.socketAgentAckRetryEnabled ||
          env.socketAgentAckMaxRetries <= 0 ||
          clientRequestId === null
        ) {
          return;
        }

        relayRoute.ackRetryTimer = setTimeout(() => {
          delete relayRoute.ackRetryTimer;
          const activeRoute = getRelayRequestRoute(requestId);
          if (
            activeRoute !== relayRoute ||
            isRouteAcked(relayRoute) ||
            relayRoute.timedOut === true ||
            input.signal?.aborted === true
          ) {
            return;
          }
          if ((relayRoute.ackRetriesAttempted ?? 0) >= env.socketAgentAckMaxRetries) {
            return;
          }

          const liveAgentSocket = findAgentSocketById(conversation.agentSocketId);
          if (!liveAgentSocket) {
            return;
          }

          relayRoute.ackRetriesAttempted = (relayRoute.ackRetriesAttempted ?? 0) + 1;
          noteBridgeAckRetryAttempt("relay");
          liveAgentSocket.emit(socketEvents.rpcRequest, wireFrame);
          if (
            !isRouteAcked(relayRoute) &&
            (relayRoute.ackRetriesAttempted ?? 0) < env.socketAgentAckMaxRetries &&
            getRelayRequestRoute(requestId) === relayRoute
          ) {
            scheduleAckRetry(wireFrame);
          }
        }, env.socketAgentAckTimeoutMs);
        relayRoute.ackRetryTimer.unref?.();
      };

      registerRelayRequestRoute(relayRoute, { countersReserved: true });
      pendingReservationConsumed = true;
      ensureRelayStreamFlowEntry(requestId);
      setRelayStreamFlowCredits(requestId, 0);

      const relayPayloadFrameOpts = payloadFrameEncodeOptionsFromPreference(
        relayCompressionPreference,
      );

      trace?.addPhaseMs("relay_preflight_ms", performance.now() - relayPreflightStart);

      try {
        assertNotAborted();
        const tEnc = performance.now();
        const wireFrame = await encodePayloadFrameBridge(commandPayload, {
          requestId,
          omitTraceId: true,
          ...relayPayloadFrameOpts,
        });
        assertNotAborted();
        const encodeElapsed = performance.now() - tEnc;
        trace?.addPhaseMs("encode_ms", encodeElapsed);
        observeRelayBridgeEncode(encodeElapsed);
        const tEmit = performance.now();
        agentSocket.emit(socketEvents.rpcRequest, wireFrame);
        const emitEnd = performance.now();
        trace?.markEmitComplete(emitEnd - tEmit, emitEnd);
        scheduleAckRetry(wireFrame);
      } catch (error: unknown) {
        removeRelayRequestRoute(requestId);
        const existingStream = getActiveStreamRouteByRequestId(requestId);
        if (existingStream && existingStream.agentSocketId === conversation.agentSocketId) {
          removeActiveStreamRoute(existingStream);
        }
        const aborted = input.signal?.aborted === true;
        if (!aborted) {
          registerAgentFailure(conversation.agentId);
        }
        const err = error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request");
        const appErr = err instanceof AppError ? err : null;
        if (trace && !trace.isFinalized()) {
          trace.finalizeOnce({
            outcome: aborted ? "abort" : "error",
            httpStatus: appErr?.statusCode ?? 503,
            errorCode: appErr?.code ?? "BRIDGE_ERROR",
          });
        }
        observeBridgeRpcMethod({
          channel: "relay",
          method: relayRoute.jsonRpcMethod ?? "unknown",
          outcome: aborted ? "abort" : "error",
          elapsedMs: Date.now() - relayRoute.createdAtMs,
        });
        if (clientRequestId) {
          const idempotencyMap = getRelayIdempotencyMap(conversation.conversationId);
          const entry = idempotencyMap?.get(clientRequestId);
          const waiters = entry?.pendingReplayConsumerSocketIds;
          if (waiters && waiters.size > 0) {
            // JSON-RPC 2.0 §5: echo the consumer's id on synthetic responses so
            // waiters that opted into `fastPath: true` can route the error back
            // to their pending — `relay:rpc.accepted` is never emitted on
            // that path. See `docs/plug_agente/01_relay_body_id_echo.md`.
            const errorPayload = {
              jsonrpc: "2.0",
              id: clientRequestId,
              error: {
                code: -32000,
                message: err.message,
                data: { code: appErr?.code ?? "BRIDGE_ERROR" },
              },
            };
            noteRelayBodyIdEcho();
            enqueueRelayOutbound(requestId, async () => {
              const frame = await encodeRelayOutboundFrame(errorPayload, requestId);
              for (const waiterSocketId of waiters) {
                emitToConsumer(waiterSocketId, socketEvents.relayRpcResponse, frame);
              }
            });
          }
          removeRelayIdempotencyEntry(conversation.conversationId, clientRequestId);
        }
        throw err;
      }

      relayMetrics.requestsAccepted += 1;
      conversationRegistry.touchInternal(conversation.conversationId);

      return {
        requestId,
        ...(clientRequestId !== null ? { clientRequestId } : {}),
        ...(input.fastPath === true ? { fastPath: true } : {}),
      };
    } finally {
      if (!pendingReservationConsumed) {
        pendingReservation.release();
      }
    }
  };

  const prepareRelayStreamPull = async (
    input: RequestRelayStreamPullInput,
  ): Promise<PreparedRelayStreamPull> => {
    const tDecode = performance.now();
    const decoded = await decodePayloadFrameAsync(input.rawFramePayload);
    observeRelayFrameDecode(performance.now() - tDecode);
    if (!decoded.ok) {
      logRpcFrameDecodeFailure({
        eventName: socketEvents.relayRpcStreamPull,
        socketId: input.consumerSocketId,
        reason: decoded.error.message,
      });
      throw badRequest(decoded.error.message);
    }

    const payload = toRecord(decoded.value.data);
    if (!payload) {
      throw badRequest("relay:rpc.stream.pull frame must contain a JSON object payload");
    }

    const conversation = conversationRegistry.findInternalByConversationId(input.conversationId);
    if (!conversation || conversation.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Conversation");
    }

    const requestId = toRequestId(payload.request_id);
    const streamId = toRequestId(payload.stream_id);
    if (
      payload.window_size !== undefined &&
      (typeof payload.window_size !== "number" ||
        !Number.isFinite(payload.window_size) ||
        payload.window_size <= 0)
    ) {
      throw badRequest("relay:rpc.stream.pull window_size must be a positive number");
    }

    const prepared = prepareAgentStreamPull({
      consumerSocketId: input.consumerSocketId,
      conversationId: input.conversationId,
      ...(requestId ? { requestId } : {}),
      ...(streamId ? { streamId } : {}),
      ...(typeof payload.window_size === "number" && Number.isFinite(payload.window_size)
        ? { windowSize: payload.window_size }
        : {}),
    });

    return {
      requestId: prepared.requestId,
      streamId: prepared.streamId,
      windowSize: prepared.windowSize,
      execute: () => {
        const result = prepared.execute();
        conversationRegistry.touchInternal(conversation.conversationId);
        return result;
      },
    };
  };

  const requestRelayStreamPull = async (
    input: RequestRelayStreamPullInput,
  ): Promise<RequestAgentStreamPullResult> => {
    const prepared = await prepareRelayStreamPull(input);
    return prepared.execute();
  };

  return {
    dispatchRelayRpcToAgent,
    prepareRelayStreamPull,
    requestRelayStreamPull,
  };
};
