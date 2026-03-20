import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { logger } from "../../../shared/utils/logger";
import { encodePayloadFrame } from "../../../shared/utils/payload_frame";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { relayMetrics } from "./bridge_relay_health_metrics";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
} from "./active_stream_registry";
import { getRelayIdempotencyMap } from "./relay_idempotency_store";
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
  const drainBufferedChunks = (): void => {
    const credits = relayStreamFlowState.creditsByRequestId.get(route.requestId) ?? 0;
    if (credits <= 0) {
      return;
    }

    const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId);
    if (!buffered || buffered.length === 0) {
      return;
    }

    let available = credits;
    while (available > 0 && buffered.length > 0) {
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
  };

  const flushPendingComplete = (): void => {
    const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId);
    if (buffered && buffered.length > 0) {
      return;
    }

    const pendingComplete = relayStreamFlowState.pendingCompleteByRequestId.get(route.requestId);
    if (!pendingComplete) {
      return;
    }

    emitToConsumer(
      route.consumerSocketId,
      socketEvents.relayRpcComplete,
      encodePayloadFrame(pendingComplete, { requestId: route.requestId }),
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
    removeRelayRequestRoute(route.requestId);
    const existingStream = getActiveStreamRouteByRequestId(route.requestId);
    if (existingStream) {
      removeActiveStreamRoute(existingStream);
    }
  };

  return {
    consumerSocketId: route.consumerSocketId,
    conversationId: route.conversationId,
    mode: "relay",
    onChunk: (payload) => {
      const available = relayStreamFlowState.creditsByRequestId.get(route.requestId) ?? 0;
      if (available > 0) {
        relayStreamFlowState.creditsByRequestId.set(route.requestId, available - 1);
        emitToConsumer(
          route.consumerSocketId,
          socketEvents.relayRpcChunk,
          encodePayloadFrame(payload, { requestId: route.requestId }),
        );
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
        flushPendingComplete();
        return;
      }

      const buffered = relayStreamFlowState.bufferedChunksByRequestId.get(route.requestId) ?? [];
      if (
        buffered.length >= relayMaxBufferedChunksPerRequest ||
        relayStreamFlowState.totalBufferedChunks >= relayMaxTotalBufferedChunks
      ) {
        relayMetrics.chunksDropped += 1;
        logger.warn("relay_chunk_dropped_due_to_backpressure", {
          requestId: route.requestId,
          conversationId: route.conversationId,
          bufferedInRequest: buffered.length,
          bufferedGlobal: relayStreamFlowState.totalBufferedChunks,
        });
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
      flushPendingComplete();
    },
  };
};

export const emitRelayTimeoutResponse = (
  route: RelayRequestRoute,
  emitToConsumer: EmitToConsumerFn,
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

  const frame = encodePayloadFrame(errorPayload, { requestId: route.requestId });
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
};
