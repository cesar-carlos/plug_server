import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { logger } from "../../../shared/utils/logger";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { relayMetrics } from "./bridge_relay_health_metrics";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
} from "./active_stream_registry";
import { getRelayIdempotencyMap } from "./relay_idempotency_store";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import { relayStreamFlowState } from "./relay_stream_flow_state";
import type { RelayRequestRoute } from "./relay_request_registry";
import { removeRelayRequestRoute } from "./relay_request_registry";
import type { StreamEventHandlers } from "./rest_pending_requests";

const relayMaxBufferedChunksPerRequest = env.socketRelayMaxBufferedChunksPerRequest;
const relayMaxTotalBufferedChunks = env.socketRelayMaxTotalBufferedChunks;
const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

export type EmitToConsumerFn = (
  consumerSocketId: string,
  eventName: string,
  payload: unknown,
) => void;

export const createRelayStreamHandlers = (
  route: RelayRequestRoute,
  emitToConsumer: EmitToConsumerFn,
): StreamEventHandlers => {
  const countChunkRows = (payload: Record<string, unknown>): number => {
    return Array.isArray(payload.rows) ? payload.rows.length : 0;
  };

  const addForwardedRows = (payload: Record<string, unknown>): void => {
    const next =
      (relayStreamFlowState.forwardedRowsByRequestId.get(route.requestId) ?? 0) + countChunkRows(payload);
    relayStreamFlowState.forwardedRowsByRequestId.set(route.requestId, next);
  };

  const emitRelayTerminalComplete = (
    terminalStatus: "aborted" | "error",
    reason: string,
    payload?: Record<string, unknown>,
  ): void => {
    relayMetrics.streamTerminalCompletions += 1;
    const streamId = toRequestId(payload?.stream_id) ?? getActiveStreamRouteByRequestId(route.requestId)?.streamId;
    const terminalPayload: Record<string, unknown> = {
      request_id: route.requestId,
      total_rows: relayStreamFlowState.forwardedRowsByRequestId.get(route.requestId) ?? 0,
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

  const scheduleFlushPendingComplete = (): void => {
    const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId);
    if (buffered && buffered.length > 0) {
      return;
    }
    if (!relayStreamFlowState.pendingCompleteByRequestId.get(route.requestId)) {
      return;
    }

    enqueueRelayOutbound(route.requestId, async () => {
      const buf = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId);
      if (buf && buf.length > 0) {
        return;
      }
      const pendingComplete = relayStreamFlowState.pendingCompleteByRequestId.get(route.requestId);
      if (!pendingComplete) {
        return;
      }

      const frame = await encodeRelayOutboundFrame(pendingComplete, route.requestId);
      emitToConsumer(
        route.consumerSocketId,
        socketEvents.relayRpcComplete,
        frame,
      );

      const streamId = toRequestId(pendingComplete.stream_id);
      void recordSocketAuditEvent({
        eventType: socketEvents.relayRpcComplete,
        actorSocketId: route.agentSocketId,
        direction: "agent_to_consumer",
        conversationId: route.conversationId,
        agentId: route.agentId,
        requestId: route.requestId,
        ...(streamId ? { streamId } : {}),
      });

      relayStreamFlowState.pendingCompleteByRequestId.delete(route.requestId);
      route.latencyTrace?.finalizeRelayStreamComplete();
      removeRelayRequestRoute(route.requestId);
      const existingStream = getActiveStreamRouteByRequestId(route.requestId);
      if (existingStream) {
        removeActiveStreamRoute(existingStream);
      }
    });
  };

  const drainBufferedChunks = (): void => {
    const creditsSnapshot = relayStreamFlowState.creditsByRequestId.get(route.requestId) ?? 0;
    if (creditsSnapshot <= 0) {
      return;
    }
    const bufferedSnapshot = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId);
    if (!bufferedSnapshot || bufferedSnapshot.length === 0) {
      return;
    }

    enqueueRelayOutbound(route.requestId, async () => {
      let available = relayStreamFlowState.creditsByRequestId.get(route.requestId) ?? 0;
      const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId) ?? [];

      while (available > 0 && buffered.length > 0) {
        const chunk = buffered.shift();
        if (!chunk) {
          break;
        }
        relayStreamFlowState.totalBufferedChunks = Math.max(
          0,
          relayStreamFlowState.totalBufferedChunks - 1,
        );
        addForwardedRows(chunk);

        const frame = await encodeRelayOutboundFrame(chunk, route.requestId);
        emitToConsumer(route.consumerSocketId, socketEvents.relayRpcChunk, frame);
        relayMetrics.chunksForwarded += 1;

        const streamId = toRequestId(chunk.stream_id);
        void recordSocketAuditEvent({
          eventType: socketEvents.relayRpcChunk,
          actorSocketId: route.agentSocketId,
          direction: "agent_to_consumer",
          conversationId: route.conversationId,
          agentId: route.agentId,
          requestId: route.requestId,
          ...(streamId ? { streamId } : {}),
        });

        available -= 1;
      }

      relayStreamFlowState.creditsByRequestId.set(route.requestId, Math.max(0, available));
      relayStreamFlowState.bufferedChunksByRequestId.set(route.requestId, buffered);
      scheduleFlushPendingComplete();
    });
  };

  return {
    consumerSocketId: route.consumerSocketId,
    conversationId: route.conversationId,
    mode: "relay",
    onChunk: (payload) => {
      const available = relayStreamFlowState.creditsByRequestId.get(route.requestId) ?? 0;
      if (available > 0) {
        relayStreamFlowState.creditsByRequestId.set(route.requestId, available - 1);

        enqueueRelayOutbound(route.requestId, async () => {
          addForwardedRows(payload);
          const frame = await encodeRelayOutboundFrame(payload, route.requestId);
          emitToConsumer(route.consumerSocketId, socketEvents.relayRpcChunk, frame);
          relayMetrics.chunksForwarded += 1;

          const streamId = toRequestId(payload.stream_id);
          void recordSocketAuditEvent({
            eventType: socketEvents.relayRpcChunk,
            actorSocketId: route.agentSocketId,
            direction: "agent_to_consumer",
            conversationId: route.conversationId,
            agentId: route.agentId,
            requestId: route.requestId,
            ...(streamId ? { streamId } : {}),
          });
          scheduleFlushPendingComplete();
        });
        return;
      }

      const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId) ?? [];
      if (
        buffered.length >= relayMaxBufferedChunksPerRequest ||
        relayStreamFlowState.totalBufferedChunks >= relayMaxTotalBufferedChunks
      ) {
        relayMetrics.chunksDropped += 1;
        emitRelayTerminalComplete("aborted", "relay_backpressure_buffer_limit", payload);
        return;
      }

      buffered.push(payload);
      relayStreamFlowState.bufferedChunksByRequestId.set(route.requestId, buffered);
      relayStreamFlowState.totalBufferedChunks += 1;
      relayMetrics.chunksBuffered += 1;
    },
    onComplete: (payload) => {
      relayStreamFlowState.pendingCompleteByRequestId.set(route.requestId, payload);
      drainBufferedChunks();
      scheduleFlushPendingComplete();
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
