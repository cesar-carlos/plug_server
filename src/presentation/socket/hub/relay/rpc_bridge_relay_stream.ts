import { recordSocketAuditEvent } from "../../../../application/services/socket_audit.service";
import { observeBridgeRpcMethod } from "../../../../application/services/bridge_rpc_method_metrics.service";
import { env } from "../../../../shared/config/env";
import { noteRelayBodyIdEcho, noteRelayChunkAfterCompleteDropped } from "../../../../shared/metrics/socket_consumer.metrics";
import { sampledMetricDelta } from "../../../../shared/metrics/metrics_sample";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { logger } from "../../../../shared/utils/logger";
import { toRequestId } from "../../../../shared/utils/rpc_types";
import { relayMetrics } from "./bridge_relay_health_metrics";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  getRelayIdempotencyMap,
  setRelayIdempotencyEntry,
} from "../registries/relay_idempotency_store";
import {
  enqueueRelayOutbound,
  encodeRelayOutboundFrame,
} from "./relay_outbound_queue";
import type { RelayChunkRawForward } from "./relay_stream_flow_state";
import {
  getRelayStreamFlowCredits,
  getRelayStreamBufferedChunkCount,
  addRelayStreamBufferedChunk,
  setRelayStreamPendingComplete,
  getRelayStreamForwardedRows,
  getRelayStreamTotalBufferedChunks,
  getRelayStreamBufferedBytes,
  getRelayStreamTotalBufferedBytes,
  countRelayStreamAbortDropped,
} from "./relay_stream_flow_state";
import { scheduleRelayStreamDrain } from "./relay_stream_drain_scheduler";
import type { RelayRequestRoute } from "../registries/relay_request_registry";
import {
  getRelayRequestRoute,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import {
  registerRelayStreamTimeouts,
  touchRelayStreamTimeout,
} from "../registries/relay_stream_timeout_registry";
import type { StreamEventHandlers } from "../registries/rest_pending_requests";
import {
  resolveStreamChunkOriginalSizeBytes,
  type StreamChunkMetadata,
} from "./stream_chunk_metadata";

const relayMaxBufferedChunksPerRequest = env.socketRelayMaxBufferedChunksPerRequest;
const relayMaxTotalBufferedChunks = env.socketRelayMaxTotalBufferedChunks;
const relayMaxBufferedBytesPerRequest = env.socketRelayMaxBufferedBytesPerRequest;
const relayMaxTotalBufferedBytes = env.socketRelayMaxTotalBufferedBytes;
const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

export type EmitToConsumerFn = (
  consumerSocketId: string,
  eventName: string,
  payload: unknown,
) => boolean;

export const createRelayStreamHandlers = (
  route: RelayRequestRoute,
  emitToConsumer: EmitToConsumerFn,
): StreamEventHandlers => {
  let drainScheduled = false;
  let terminalEmitted = false;
  let completeReceived = false;

  const isRouteActive = (): boolean => {
    return getRelayRequestRoute(route.requestId) === route;
  };

  const emitRelayTerminalComplete = (
    terminalStatus: "aborted" | "error",
    reason: string,
    payload?: Record<string, unknown>,
    errorCode?: string,
  ): void => {
    if (terminalEmitted) {
      return;
    }
    terminalEmitted = true;
    relayMetrics.streamTerminalCompletions += 1;
    const streamId =
      toRequestId(payload?.stream_id) ?? getActiveStreamRouteByRequestId(route.requestId)?.streamId;
    const dropped =
      terminalStatus === "aborted"
        ? countRelayStreamAbortDropped(route.requestId, payload)
        : undefined;
    const terminalPayload: Record<string, unknown> = {
      request_id: route.requestId,
      total_rows: getRelayStreamForwardedRows(route.requestId),
      terminal_status: terminalStatus,
      ...(streamId ? { stream_id: streamId } : {}),
      ...(dropped
        ? { dropped_chunks: dropped.droppedChunks, dropped_rows: dropped.droppedRows }
        : {}),
      ...(errorCode ? { error_code: errorCode, reason } : {}),
    };

    logger.warn("relay_stream_terminated", {
      requestId: route.requestId,
      conversationId: route.conversationId,
      terminalStatus,
      reason,
      ...(streamId ? { streamId } : {}),
    });

    route.latencyTrace?.finalizeOnce({
      outcome: "error",
      httpStatus: 503,
      errorCode:
        errorCode ??
        (terminalStatus === "aborted" ? "RELAY_STREAM_ABORTED" : "RELAY_STREAM_FRAME_INVALID"),
    });
    observeBridgeRpcMethod({
      channel: "relay",
      method: route.jsonRpcMethod ?? "unknown",
      outcome: "error",
      elapsedMs: Date.now() - route.createdAtMs,
    });

    removeRelayRequestRoute(route.requestId);
    const activeRoute = getActiveStreamRouteByRequestId(route.requestId);
    if (activeRoute) {
      removeActiveStreamRoute(activeRoute);
    }

    enqueueRelayOutbound(route.requestId, async () => {
      const frame = await encodeRelayOutboundFrame(terminalPayload, route.requestId);
      emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame);

      void recordSocketAuditEvent({
        eventType: socketEvents.relayRpcComplete,
        actorSocketId: route.agentSocketId,
        direction: "agent_to_consumer",
        conversationId: route.conversationId,
        agentId: route.agentId,
        requestId: route.requestId,
        ...(streamId ? { streamId } : {}),
      });
    });
  };

  registerRelayStreamTimeouts(route.requestId, (timeoutReason) => {
    if (timeoutReason === "idle") {
      relayMetrics.streamIdleTimeouts += 1;
    } else {
      relayMetrics.streamLifetimeTimeouts += 1;
    }
    emitRelayTerminalComplete(
      "error",
      timeoutReason === "idle" ? "relay_stream_idle_timeout" : "relay_stream_lifetime_timeout",
      undefined,
      "RELAY_STREAM_TIMEOUT",
    );
  });

  const scheduleDrainAndFlush = (): void => {
    scheduleRelayStreamDrain({
      route: {
        requestId: route.requestId,
        consumerSocketId: route.consumerSocketId,
        agentSocketId: route.agentSocketId,
        conversationId: route.conversationId,
        agentId: route.agentId,
        relayRoute: route,
      },
      emitToConsumer,
      isActive: isRouteActive,
      onComplete: (_streamId) => {
        route.latencyTrace?.finalizeRelayStreamComplete();
        observeBridgeRpcMethod({
          channel: "relay",
          method: route.jsonRpcMethod ?? "unknown",
          outcome: "success",
          elapsedMs: Date.now() - route.createdAtMs,
        });
        removeRelayRequestRoute(route.requestId);
        const existingStream = getActiveStreamRouteByRequestId(route.requestId);
        if (existingStream) {
          removeActiveStreamRoute(existingStream);
        }
      },
      getDrainScheduled: () => drainScheduled,
      setDrainScheduled: (value) => {
        drainScheduled = value;
      },
      reschedule: scheduleDrainAndFlush,
    });
  };

  return {
    consumerSocketId: route.consumerSocketId,
    conversationId: route.conversationId,
    mode: "relay",
    onChunk: (payload, metadata?: StreamChunkMetadata, rawForward?: RelayChunkRawForward) => {
      if (completeReceived) {
        noteRelayChunkAfterCompleteDropped();
        logger.warn("relay_chunk_after_complete_dropped", {
          requestId: route.requestId,
          conversationId: route.conversationId,
        });
        return;
      }
      touchRelayStreamTimeout(route.requestId);
      const available = getRelayStreamFlowCredits(route.requestId);
      const payloadBytes = resolveStreamChunkOriginalSizeBytes(
        payload,
        metadata,
        env.socketIoMaxHttpBufferBytes,
      );
      if (
        getRelayStreamBufferedChunkCount(route.requestId) >= relayMaxBufferedChunksPerRequest ||
        getRelayStreamTotalBufferedChunks() >= relayMaxTotalBufferedChunks
      ) {
        relayMetrics.chunksDropped += 1;
        emitRelayTerminalComplete("aborted", "relay_backpressure_buffer_limit", payload);
        return;
      }
      if (
        getRelayStreamBufferedBytes(route.requestId) + payloadBytes >
          relayMaxBufferedBytesPerRequest ||
        getRelayStreamTotalBufferedBytes() + payloadBytes > relayMaxTotalBufferedBytes
      ) {
        relayMetrics.chunksDropped += 1;
        emitRelayTerminalComplete(
          "aborted",
          "relay_backpressure_buffer_byte_limit",
          payload,
          "RELAY_STREAM_BUFFER_BYTE_LIMIT",
        );
        return;
      }

      addRelayStreamBufferedChunk(route.requestId, payload, payloadBytes, rawForward);
      if (available <= 0) {
        relayMetrics.chunksBuffered += sampledMetricDelta(1);
      }
      scheduleDrainAndFlush();
    },
    onComplete: (payload) => {
      completeReceived = true;
      touchRelayStreamTimeout(route.requestId);
      setRelayStreamPendingComplete(route.requestId, payload);
      scheduleDrainAndFlush();
    },
  };
};

export const emitRelayTimeoutResponse = (
  route: RelayRequestRoute,
  emitToConsumer: EmitToConsumerFn,
  /** Runs after the timeout frame is encoded and emitted (e.g. remove relay route). */
  afterEmit?: () => void,
): void => {
  if (route.settled === true) {
    return;
  }
  // JSON-RPC 2.0 §5 — synthetic responses must echo the consumer's `id` so
  // the response is routable on `fastPath: true` (no `relay:rpc.accepted` to
  // anchor the mapping). See `docs/plug_agente/01_relay_body_id_echo.md`.
  const outboundBodyId = route.clientRequestId ?? route.requestId;
  if (outboundBodyId !== route.requestId) {
    noteRelayBodyIdEcho();
  }
  const errorPayload = {
    jsonrpc: "2.0",
    id: outboundBodyId,
    error: {
      code: -32000,
      message: "Timed out waiting for agent response",
      data: {
        code: "RELAY_REQUEST_TIMEOUT",
        conversation_id: route.conversationId,
      },
    },
  };

  enqueueRelayOutbound(route.requestId, async () => {
    const frame = await encodeRelayOutboundFrame(errorPayload, route.requestId);
    emitToConsumer(route.consumerSocketId, socketEvents.relayRpcResponse, frame);

    const idempotencyMap = getRelayIdempotencyMap(route.conversationId);
    if (idempotencyMap && route.clientRequestId) {
      const item = idempotencyMap.get(route.clientRequestId);
      if (item && item.requestId === route.requestId) {
        const waiters = item.pendingReplayConsumerSocketIds;
        item.responseFrame = frame;
        item.expiresAtMs = Date.now() + relayIdempotencyTtlMs;
        setRelayIdempotencyEntry(route.conversationId, route.clientRequestId, item);
        if (waiters && waiters.size > 0) {
          for (const waiterSocketId of waiters) {
            if (waiterSocketId === route.consumerSocketId) {
              continue;
            }
            emitToConsumer(waiterSocketId, socketEvents.relayRpcResponse, frame);
          }
        }
      }
    }

    afterEmit?.();
  });
};
