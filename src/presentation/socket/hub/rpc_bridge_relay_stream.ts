import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { logger } from "../../../shared/utils/logger";
import { toRequestId } from "../../../shared/utils/rpc_types";
import {
  observeRelayBufferDrain,
  observeRelayChunkForwardJob,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import { getActiveStreamRouteByRequestId, removeActiveStreamRoute } from "./active_stream_registry";
import { getRelayIdempotencyMap } from "./relay_idempotency_store";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import {
  getRelayStreamFlowCredits,
  getRelayStreamBufferedChunks,
  addRelayStreamBufferedChunk,
  getRelayStreamPendingComplete,
  setRelayStreamPendingComplete,
  getRelayStreamForwardedRows,
  getRelayStreamTotalBufferedChunks,
  drainRelayStreamBuffer,
} from "./relay_stream_flow_state";
import type { RelayRequestRoute } from "./relay_request_registry";
import { removeRelayRequestRoute } from "./relay_request_registry";
import type { StreamEventHandlers } from "./rest_pending_requests";

const relayMaxBufferedChunksPerRequest = env.socketRelayMaxBufferedChunksPerRequest;
const relayMaxTotalBufferedChunks = env.socketRelayMaxTotalBufferedChunks;
const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;
const shouldAuditRelayChunks = env.socketAuditHighVolumeSamplePercent > 0;

export type EmitToConsumerFn = (
  consumerSocketId: string,
  eventName: string,
  payload: unknown,
) => void;

export const createRelayStreamHandlers = (
  route: RelayRequestRoute,
  emitToConsumer: EmitToConsumerFn,
): StreamEventHandlers => {
  let drainScheduled = false;

  const emitRelayTerminalComplete = (
    terminalStatus: "aborted" | "error",
    reason: string,
    payload?: Record<string, unknown>,
  ): void => {
    relayMetrics.streamTerminalCompletions += 1;
    const streamId =
      toRequestId(payload?.stream_id) ?? getActiveStreamRouteByRequestId(route.requestId)?.streamId;
    const terminalPayload: Record<string, unknown> = {
      request_id: route.requestId,
      total_rows: getRelayStreamForwardedRows(route.requestId),
      terminal_status: terminalStatus,
      ...(streamId ? { stream_id: streamId } : {}),
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
        terminalStatus === "aborted" ? "RELAY_STREAM_ABORTED" : "RELAY_STREAM_FRAME_INVALID",
    });

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

      removeRelayRequestRoute(route.requestId);
      const existingStream = getActiveStreamRouteByRequestId(route.requestId);
      if (existingStream) {
        removeActiveStreamRoute(existingStream);
      }
    });
  };

  const scheduleDrainAndFlush = (): void => {
    if (drainScheduled) {
      return;
    }
    const creditsSnapshot = getRelayStreamFlowCredits(route.requestId);
    const bufferedSnapshot = getRelayStreamBufferedChunks(route.requestId);
    if (creditsSnapshot <= 0 || bufferedSnapshot.length === 0) {
      const pendingComplete = getRelayStreamPendingComplete(route.requestId);
      if (bufferedSnapshot.length === 0 && pendingComplete) {
        drainScheduled = true;
        enqueueRelayOutbound(route.requestId, async () => {
          const tDrain = performance.now();
          try {
            const result = await drainRelayStreamBuffer({
              requestId: route.requestId,
              consumerSocketId: route.consumerSocketId,
              agentSocketId: route.agentSocketId,
              conversationId: route.conversationId,
              agentId: route.agentId,
              emitChunk: (frame) =>
                emitToConsumer(route.consumerSocketId, socketEvents.relayRpcChunk, frame),
              emitComplete: (frame) =>
                emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame),
              encodeFrame: (data) => encodeRelayOutboundFrame(data, route.requestId),
              recordAudit: (eventType, extras) => {
                if (!shouldAuditRelayChunks && eventType === socketEvents.relayRpcChunk) {
                  return;
                }
                void recordSocketAuditEvent({
                  eventType,
                  actorSocketId: route.agentSocketId,
                  direction: "agent_to_consumer",
                  conversationId: route.conversationId,
                  agentId: route.agentId,
                  requestId: route.requestId,
                  ...extras,
                });
              },
              onComplete: (_streamId) => {
                route.latencyTrace?.finalizeRelayStreamComplete();
                removeRelayRequestRoute(route.requestId);
                const existingStream = getActiveStreamRouteByRequestId(route.requestId);
                if (existingStream) {
                  removeActiveStreamRoute(existingStream);
                }
              },
            });
            if (result.chunksDrained > 0) {
              relayMetrics.chunksForwarded += result.chunksDrained;
              observeRelayChunkForwardJob(performance.now() - tDrain);
            }
          } finally {
            observeRelayBufferDrain(performance.now() - tDrain);
            drainScheduled = false;
            const pendingComplete = getRelayStreamPendingComplete(route.requestId);
            const hasBuffered = getRelayStreamBufferedChunks(route.requestId).length > 0;
            const hasCredits = getRelayStreamFlowCredits(route.requestId) > 0;
            if ((hasBuffered && hasCredits) || (pendingComplete && !hasBuffered)) {
              scheduleDrainAndFlush();
            }
          }
        });
      }
      return;
    }

    drainScheduled = true;
    enqueueRelayOutbound(route.requestId, async () => {
      const tDrain = performance.now();
      try {
        const result = await drainRelayStreamBuffer({
          requestId: route.requestId,
          consumerSocketId: route.consumerSocketId,
          agentSocketId: route.agentSocketId,
          conversationId: route.conversationId,
          agentId: route.agentId,
          emitChunk: (frame) =>
            emitToConsumer(route.consumerSocketId, socketEvents.relayRpcChunk, frame),
          emitComplete: (frame) =>
            emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame),
          encodeFrame: (data) => encodeRelayOutboundFrame(data, route.requestId),
          recordAudit: (eventType, extras) => {
            if (!shouldAuditRelayChunks && eventType === socketEvents.relayRpcChunk) {
              return;
            }
            void recordSocketAuditEvent({
              eventType,
              actorSocketId: route.agentSocketId,
              direction: "agent_to_consumer",
              conversationId: route.conversationId,
              agentId: route.agentId,
              requestId: route.requestId,
              ...extras,
            });
          },
          onComplete: (_streamId) => {
            route.latencyTrace?.finalizeRelayStreamComplete();
            removeRelayRequestRoute(route.requestId);
            const existingStream = getActiveStreamRouteByRequestId(route.requestId);
            if (existingStream) {
              removeActiveStreamRoute(existingStream);
            }
          },
        });
        if (result.chunksDrained > 0) {
          relayMetrics.chunksForwarded += result.chunksDrained;
          observeRelayChunkForwardJob(performance.now() - tDrain);
        }
      } finally {
        observeRelayBufferDrain(performance.now() - tDrain);
        drainScheduled = false;
        const pendingComplete = getRelayStreamPendingComplete(route.requestId);
        const hasBuffered = getRelayStreamBufferedChunks(route.requestId).length > 0;
        const hasCredits = getRelayStreamFlowCredits(route.requestId) > 0;
        if ((hasBuffered && hasCredits) || (pendingComplete && !hasBuffered)) {
          scheduleDrainAndFlush();
        }
      }
    });
  };

  return {
    consumerSocketId: route.consumerSocketId,
    conversationId: route.conversationId,
    mode: "relay",
    onChunk: (payload) => {
      const available = getRelayStreamFlowCredits(route.requestId);

      const buffered = getRelayStreamBufferedChunks(route.requestId);
      if (
        buffered.length >= relayMaxBufferedChunksPerRequest ||
        getRelayStreamTotalBufferedChunks() >= relayMaxTotalBufferedChunks
      ) {
        relayMetrics.chunksDropped += 1;
        emitRelayTerminalComplete("aborted", "relay_backpressure_buffer_limit", payload);
        return;
      }

      addRelayStreamBufferedChunk(route.requestId, payload);
      if (available <= 0) {
        relayMetrics.chunksBuffered += 1;
      }
      scheduleDrainAndFlush();
    },
    onComplete: (payload) => {
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
  const errorPayload = {
    jsonrpc: "2.0",
    id: route.requestId,
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
        item.responseFrame = frame;
        item.expiresAtMs = Date.now() + relayIdempotencyTtlMs;
        idempotencyMap.set(route.clientRequestId, item);
      }
    }

    afterEmit?.();
  });
};
