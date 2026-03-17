import { randomUUID } from "node:crypto";

import type { Namespace } from "socket.io";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { badRequest, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { logger } from "../../../shared/utils/logger";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { socketEvents } from "../../../shared/constants/socket_events";
import { decodePayloadFrame, encodePayloadFrame } from "../../../shared/utils/payload_frame";
import { agentRegistry } from "./agent_registry";
import { conversationRegistry } from "./conversation_registry";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface PendingRequest {
  readonly socketId: string;
  readonly agentId: string;
  readonly resolve: (payload: unknown) => void;
  readonly timeoutHandle: NodeJS.Timeout;
  readonly streamHandlers?: StreamEventHandlers;
  acked: boolean;
}

interface StreamEventHandlers {
  readonly consumerSocketId: string;
  readonly conversationId?: string;
  readonly mode?: "legacy" | "relay";
  readonly onChunk: (payload: Record<string, unknown>) => void;
  readonly onComplete: (payload: Record<string, unknown>) => void;
}

interface ActiveStreamRoute {
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly requestId: string;
  readonly conversationId?: string;
  readonly mode: "legacy" | "relay";
  readonly onChunk: (payload: Record<string, unknown>) => void;
  readonly onComplete: (payload: Record<string, unknown>) => void;
  streamId?: string;
}

interface DispatchRpcCommandInput {
  readonly agentId: string;
  readonly command: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly streamHandlers?: StreamEventHandlers;
}

export interface DispatchRpcCommandResult {
  readonly requestId: string;
  readonly response: unknown;
}

interface RequestAgentStreamPullInput {
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

interface RelayRequestRoute {
  readonly requestId: string;
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly agentId: string;
  readonly timeoutHandle: NodeJS.Timeout;
  readonly createdAtMs: number;
  readonly clientRequestId?: string;
  timedOut?: boolean;
}

interface DispatchRelayRpcInput {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly rawFramePayload: unknown;
}

export interface DispatchRelayRpcResult {
  readonly requestId: string;
  readonly clientRequestId?: string;
  readonly deduplicated?: boolean;
  readonly replayed?: boolean;
}

interface RequestRelayStreamPullInput {
  readonly conversationId: string;
  readonly consumerSocketId: string;
  readonly rawFramePayload: unknown;
}

const defaultRequestTimeoutMs = 15_000;
const defaultStreamWindowSize = 1;
const relayRequestTimeoutMs = env.socketRelayRequestTimeoutMs;
const relayMaxPendingRequests = env.socketRelayMaxPendingRequests;
const relayMaxPendingRequestsPerConversation = env.socketRelayMaxPendingRequestsPerConversation;
const relayMaxPendingRequestsPerConsumer = env.socketRelayMaxPendingRequestsPerConsumer;
const relayMaxActiveStreams = env.socketRelayMaxActiveStreams;
const relayMaxBufferedChunksPerRequest = env.socketRelayMaxBufferedChunksPerRequest;
const relayMaxTotalBufferedChunks = env.socketRelayMaxTotalBufferedChunks;
const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;
const relayCircuitFailureThreshold = env.socketRelayCircuitFailureThreshold;
const relayCircuitOpenMs = env.socketRelayCircuitOpenMs;
let agentsNamespace: Namespace | null = null;
let consumersNamespace: Namespace | null = null;
const pendingRequests = new Map<string, PendingRequest>();
const activeStreamsByRequestId = new Map<string, ActiveStreamRoute>();
const activeStreamsByStreamId = new Map<string, ActiveStreamRoute>();
const relayRequestsByRequestId = new Map<string, RelayRequestRoute>();
const relayIdempotencyByConversation = new Map<
  string,
  Map<string, { requestId: string; expiresAtMs: number; responseFrame?: unknown }>
>();
const relayStreamCreditsByRequestId = new Map<string, number>();
const relayBufferedChunksByRequestId = new Map<string, Record<string, unknown>[]>();
const relayPendingCompleteByRequestId = new Map<string, Record<string, unknown>>();
let relayTotalBufferedChunks = 0;
const relayCircuitByAgentId = new Map<string, { failures: number; openUntilMs: number }>();
const relayMetrics = {
  requestsAccepted: 0,
  requestsDeduplicated: 0,
  responsesForwarded: 0,
  chunksForwarded: 0,
  chunksBuffered: 0,
  chunksDropped: 0,
  streamPulls: 0,
  requestTimeouts: 0,
  circuitOpenRejects: 0,
};
let relayMetricsTimer: NodeJS.Timeout | null = null;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const withAppendedMessage = (base: string, extra: string): string =>
  extra.trim() === "" ? base : `${base}. ${extra}`;

const cleanupExpiredIdempotency = (): void => {
  const nowMs = Date.now();
  for (const [conversationId, entries] of relayIdempotencyByConversation.entries()) {
    for (const [clientRequestId, item] of entries.entries()) {
      if (item.expiresAtMs <= nowMs) {
        entries.delete(clientRequestId);
      }
    }
    if (entries.size === 0) {
      relayIdempotencyByConversation.delete(conversationId);
    }
  }
};

const getConversationIdempotencyMap = (
  conversationId: string,
): Map<string, { requestId: string; expiresAtMs: number; responseFrame?: unknown }> => {
  const existing = relayIdempotencyByConversation.get(conversationId);
  if (existing) {
    return existing;
  }

  const created = new Map<string, { requestId: string; expiresAtMs: number; responseFrame?: unknown }>();
  relayIdempotencyByConversation.set(conversationId, created);
  return created;
};

const getRelayPendingRequestCountForConversation = (conversationId: string): number => {
  let count = 0;
  for (const item of relayRequestsByRequestId.values()) {
    if (item.conversationId === conversationId) {
      count++;
    }
  }
  return count;
};

const getRelayPendingRequestCountForConsumer = (consumerSocketId: string): number => {
  let count = 0;
  for (const item of relayRequestsByRequestId.values()) {
    if (item.consumerSocketId === consumerSocketId) {
      count++;
    }
  }
  return count;
};

const getCircuitState = (agentId: string): { failures: number; openUntilMs: number } => {
  const existing = relayCircuitByAgentId.get(agentId);
  if (existing) {
    return existing;
  }

  const created = { failures: 0, openUntilMs: 0 };
  relayCircuitByAgentId.set(agentId, created);
  return created;
};

const ensureAgentCircuitClosed = (agentId: string): void => {
  const state = getCircuitState(agentId);
  if (state.openUntilMs > Date.now()) {
    relayMetrics.circuitOpenRejects += 1;
    const retryAfterMs = Math.max(0, state.openUntilMs - Date.now());
    throw serviceUnavailable(
      withAppendedMessage("Agent circuit is open", `retry_after_ms=${retryAfterMs}`),
    );
  }
};

const registerAgentFailure = (agentId: string): void => {
  const state = getCircuitState(agentId);
  state.failures += 1;
  if (state.failures >= relayCircuitFailureThreshold) {
    state.openUntilMs = Date.now() + relayCircuitOpenMs;
    state.failures = 0;
  }
  relayCircuitByAgentId.set(agentId, state);
};

const registerAgentSuccess = (agentId: string): void => {
  const state = getCircuitState(agentId);
  if (state.failures !== 0 || state.openUntilMs !== 0) {
    state.failures = 0;
    state.openUntilMs = 0;
    relayCircuitByAgentId.set(agentId, state);
  }
};

const clearRelayRequestTimeout = (requestId: string): void => {
  const route = relayRequestsByRequestId.get(requestId);
  if (!route) {
    return;
  }

  clearTimeout(route.timeoutHandle);
};

const clearRelayFlowState = (requestId: string): void => {
  relayStreamCreditsByRequestId.delete(requestId);
  const buffered = relayBufferedChunksByRequestId.get(requestId);
  if (buffered && buffered.length > 0) {
    relayTotalBufferedChunks = Math.max(0, relayTotalBufferedChunks - buffered.length);
  }
  relayBufferedChunksByRequestId.delete(requestId);
  relayPendingCompleteByRequestId.delete(requestId);
};

const scheduleRelayMetricsLogger = (): void => {
  if (relayMetricsTimer) {
    return;
  }

  relayMetricsTimer = setInterval(() => {
    cleanupExpiredIdempotency();
    logger.info("socket_relay_metrics", {
      ...relayMetrics,
      pendingRelayRequests: relayRequestsByRequestId.size,
      activeStreams: activeStreamsByRequestId.size,
      bufferedChunks: relayTotalBufferedChunks,
      openCircuits: Array.from(relayCircuitByAgentId.values()).filter((state) => state.openUntilMs > Date.now())
        .length,
    });
  }, env.socketRelayMetricsLogIntervalMs);
  relayMetricsTimer.unref?.();
};

const pickResponseId = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  return toRequestId(record.id);
};

const pickRequestIdFromStreamPayload = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  return toRequestId(record.request_id);
};

const pickStreamIdFromStreamPayload = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  return toRequestId(record.stream_id);
};

const extractStreamIdFromRpcResponse = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  const result = toRecord(record.result);
  if (!result) {
    return null;
  }

  return toRequestId(result.stream_id);
};

const removeActiveStreamRoute = (route: ActiveStreamRoute): void => {
  activeStreamsByRequestId.delete(route.requestId);
  if (route.streamId) {
    activeStreamsByStreamId.delete(route.streamId);
  }
};

const upsertActiveStreamRoute = (
  input: {
    readonly requestId: string;
    readonly agentSocketId: string;
    readonly streamHandlers: StreamEventHandlers;
    readonly streamId?: string;
  },
): ActiveStreamRoute => {
  const existing = activeStreamsByRequestId.get(input.requestId);
  if (existing) {
    if (input.streamId) {
      existing.streamId = input.streamId;
    }
    activeStreamsByRequestId.set(input.requestId, existing);
    if (existing.streamId) {
      activeStreamsByStreamId.set(existing.streamId, existing);
    }
    return existing;
  }

  const route: ActiveStreamRoute = {
    consumerSocketId: input.streamHandlers.consumerSocketId,
    agentSocketId: input.agentSocketId,
    requestId: input.requestId,
    ...(input.streamHandlers.conversationId ? { conversationId: input.streamHandlers.conversationId } : {}),
    mode: input.streamHandlers.mode ?? "legacy",
    onChunk: input.streamHandlers.onChunk,
    onComplete: input.streamHandlers.onComplete,
    ...(input.streamId ? { streamId: input.streamId } : {}),
  };

  activeStreamsByRequestId.set(route.requestId, route);
  if (route.streamId) {
    activeStreamsByStreamId.set(route.streamId, route);
  }
  return route;
};

const resolveActiveStreamRoute = (
  socketId: string,
  payload: unknown,
): ActiveStreamRoute | null => {
  const streamId = pickStreamIdFromStreamPayload(payload);
  const requestId = pickRequestIdFromStreamPayload(payload);
  const byStream = streamId ? activeStreamsByStreamId.get(streamId) : undefined;
  const byRequest = requestId ? activeStreamsByRequestId.get(requestId) : undefined;
  const route = byStream ?? byRequest;
  if (!route || route.agentSocketId !== socketId) {
    return null;
  }

  if (streamId && !route.streamId) {
    route.streamId = streamId;
    activeStreamsByStreamId.set(streamId, route);
  }
  return route;
};

export const registerSocketBridgeServer = (namespace: Namespace): void => {
  agentsNamespace = namespace;
};

export const registerConsumerBridgeServer = (namespace: Namespace): void => {
  consumersNamespace = namespace;
  scheduleRelayMetricsLogger();
};

const emitToConsumer = (
  consumerSocketId: string,
  eventName: string,
  payload: unknown,
): void => {
  const nsp = consumersNamespace;
  if (!nsp) {
    return;
  }

  const consumerSocket = nsp.sockets.get(consumerSocketId);
  if (!consumerSocket) {
    return;
  }

  consumerSocket.emit(eventName, payload);
};

const createRelayStreamHandlers = (route: RelayRequestRoute): StreamEventHandlers => {
  const drainBufferedChunks = (): void => {
    const credits = relayStreamCreditsByRequestId.get(route.requestId) ?? 0;
    if (credits <= 0) {
      return;
    }

    const buffered = relayBufferedChunksByRequestId.get(route.requestId);
    if (!buffered || buffered.length === 0) {
      return;
    }

    let available = credits;
    while (available > 0 && buffered.length > 0) {
      const chunk = buffered.shift();
      if (!chunk) {
        break;
      }
      relayTotalBufferedChunks = Math.max(0, relayTotalBufferedChunks - 1);

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

    relayStreamCreditsByRequestId.set(route.requestId, Math.max(0, available));
    relayBufferedChunksByRequestId.set(route.requestId, buffered);
  };

  const flushPendingComplete = (): void => {
    const buffered = relayBufferedChunksByRequestId.get(route.requestId);
    if (buffered && buffered.length > 0) {
      return;
    }

    const pendingComplete = relayPendingCompleteByRequestId.get(route.requestId);
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

    relayPendingCompleteByRequestId.delete(route.requestId);
    removeRelayRequestRoute(route.requestId);
    const existingStream = activeStreamsByRequestId.get(route.requestId);
    if (existingStream) {
      removeActiveStreamRoute(existingStream);
    }
  };

  return {
    consumerSocketId: route.consumerSocketId,
    conversationId: route.conversationId,
    mode: "relay",
    onChunk: (payload) => {
      const available = relayStreamCreditsByRequestId.get(route.requestId) ?? 0;
      if (available > 0) {
        relayStreamCreditsByRequestId.set(route.requestId, available - 1);
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

      const buffered = relayBufferedChunksByRequestId.get(route.requestId) ?? [];
      if (
        buffered.length >= relayMaxBufferedChunksPerRequest ||
        relayTotalBufferedChunks >= relayMaxTotalBufferedChunks
      ) {
        relayMetrics.chunksDropped += 1;
        logger.warn("relay_chunk_dropped_due_to_backpressure", {
          requestId: route.requestId,
          conversationId: route.conversationId,
          bufferedInRequest: buffered.length,
          bufferedGlobal: relayTotalBufferedChunks,
        });
        return;
      }

      buffered.push(payload);
      relayBufferedChunksByRequestId.set(route.requestId, buffered);
      relayTotalBufferedChunks += 1;
      relayMetrics.chunksBuffered += 1;
    },
    onComplete: (payload) => {
      relayPendingCompleteByRequestId.set(route.requestId, payload);
      drainBufferedChunks();
      flushPendingComplete();
    },
  };
};

const removeRelayRequestRoute = (requestId: string): RelayRequestRoute | null => {
  const route = relayRequestsByRequestId.get(requestId);
  if (!route) {
    clearRelayFlowState(requestId);
    return null;
  }

  clearTimeout(route.timeoutHandle);
  relayRequestsByRequestId.delete(requestId);
  clearRelayFlowState(requestId);
  return route;
};

const emitRelayTimeoutResponse = (route: RelayRequestRoute): void => {
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

  const idempotencyMap = relayIdempotencyByConversation.get(route.conversationId);
  if (idempotencyMap && route.clientRequestId) {
    const item = idempotencyMap.get(route.clientRequestId);
    if (item && item.requestId === route.requestId) {
      item.responseFrame = frame;
      item.expiresAtMs = Date.now() + relayIdempotencyTtlMs;
      idempotencyMap.set(route.clientRequestId, item);
    }
  }
};

export const handleAgentRpcResponse = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const responseId = pickResponseId(decoded.value.data);
  if (!responseId) {
    return;
  }

  const streamId = extractStreamIdFromRpcResponse(decoded.value.data);
  const pendingRequest = pendingRequests.get(responseId);
  if (pendingRequest && pendingRequest.socketId === socketId) {
    if (pendingRequest.streamHandlers) {
      if (streamId) {
        upsertActiveStreamRoute({
          requestId: responseId,
          agentSocketId: socketId,
          streamHandlers: pendingRequest.streamHandlers,
          streamId,
        });
        logger.info("rpc_stream_registered", { requestId: responseId, streamId, socketId });
      } else {
        const existingStream = activeStreamsByRequestId.get(responseId);
        if (existingStream && existingStream.agentSocketId === socketId) {
          removeActiveStreamRoute(existingStream);
        }
      }
    }

    if (!pendingRequest.acked) {
      logger.info("rpc_response_received_without_ack", { requestId: responseId, socketId });
    }

    registerAgentSuccess(pendingRequest.agentId);
    clearTimeout(pendingRequest.timeoutHandle);
    pendingRequests.delete(responseId);
    pendingRequest.resolve(decoded.value.data);
  }

  const relayRoute = relayRequestsByRequestId.get(responseId);
  if (!relayRoute || relayRoute.agentSocketId !== socketId) {
    return;
  }

  const responseFrame = encodePayloadFrame(decoded.value.data, { requestId: responseId });
  emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, responseFrame);
  relayMetrics.responsesForwarded += 1;
  registerAgentSuccess(relayRoute.agentId);
  clearTimeout(relayRoute.timeoutHandle);
  conversationRegistry.touch(relayRoute.conversationId);

  if (relayRoute.clientRequestId) {
    const idempotencyMap = getConversationIdempotencyMap(relayRoute.conversationId);
    idempotencyMap.set(relayRoute.clientRequestId, {
      requestId: relayRoute.requestId,
      expiresAtMs: Date.now() + relayIdempotencyTtlMs,
      responseFrame,
    });
  }

  if (streamId) {
    upsertActiveStreamRoute({
      requestId: responseId,
      agentSocketId: socketId,
      streamHandlers: createRelayStreamHandlers(relayRoute),
      streamId,
    });
    relayStreamCreditsByRequestId.set(responseId, 0);
  } else {
    const existingStream = activeStreamsByRequestId.get(responseId);
    if (existingStream && existingStream.agentSocketId === socketId) {
      removeActiveStreamRoute(existingStream);
    }
    removeRelayRequestRoute(responseId);
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
};

export const handleAgentRpcChunk = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const route = resolveActiveStreamRoute(socketId, data);
  if (!route) {
    return;
  }

  if (route.conversationId) {
    conversationRegistry.touch(route.conversationId);
  }

  try {
    route.onChunk(data);
  } catch {
    logger.warn("rpc_stream_chunk_forward_failed", {
      requestId: route.requestId,
      streamId: route.streamId,
      socketId,
    });
  }
};

export const handleAgentRpcComplete = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const route = resolveActiveStreamRoute(socketId, data);
  if (!route) {
    return;
  }

  if (route.conversationId) {
    conversationRegistry.touch(route.conversationId);
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
};

export const handleAgentRpcAck = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const requestId = toRequestId(data.request_id);
  if (!requestId) {
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (pending && pending.socketId === socketId) {
    pending.acked = true;
    logger.info("rpc_ack_received", { requestId, socketId });
  }

  const relayRoute = relayRequestsByRequestId.get(requestId);
  if (relayRoute && relayRoute.agentSocketId === socketId) {
    emitToConsumer(
      relayRoute.consumerSocketId,
      socketEvents.relayRpcRequestAck,
      encodePayloadFrame(data, { requestId }),
    );
  }
};

export const handleAgentBatchAck = (socketId: string, rawPayload: unknown): void => {
  const decoded = decodePayloadFrame(rawPayload);
  if (!decoded.ok) {
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const requestIds = Array.isArray(data.request_ids)
    ? (data.request_ids as unknown[]).map((id) => toRequestId(id)).filter((id): id is string => id !== null)
    : [];

  let ackedCount = 0;
  for (const requestId of requestIds) {
    const pending = pendingRequests.get(requestId);
    if (pending && pending.socketId === socketId) {
      pending.acked = true;
      ackedCount++;
    }

    const relayRoute = relayRequestsByRequestId.get(requestId);
    if (relayRoute && relayRoute.agentSocketId === socketId) {
      emitToConsumer(
        relayRoute.consumerSocketId,
        socketEvents.relayRpcBatchAck,
        encodePayloadFrame(data, { requestId }),
      );
    }
  }
  if (ackedCount > 0) {
    logger.info("rpc_batch_ack_received", { requestIds: requestIds.slice(0, 5), ackedCount, socketId });
  }
};

export const cleanupConsumerStreamSubscriptions = (consumerSocketId: string): void => {
  for (const route of Array.from(activeStreamsByRequestId.values())) {
    if (route.consumerSocketId === consumerSocketId) {
      if (route.mode === "relay") {
        removeRelayRequestRoute(route.requestId);
      }
      removeActiveStreamRoute(route);
    }
  }

  for (const [requestId, route] of relayRequestsByRequestId.entries()) {
    if (route.consumerSocketId === consumerSocketId) {
      removeRelayRequestRoute(requestId);
    }
  }
};

export const cleanupAgentStreamSubscriptions = (agentSocketId: string): void => {
  for (const route of Array.from(activeStreamsByRequestId.values())) {
    if (route.agentSocketId === agentSocketId) {
      if (route.mode === "relay") {
        removeRelayRequestRoute(route.requestId);
      }
      removeActiveStreamRoute(route);
    }
  }

  for (const [requestId, route] of relayRequestsByRequestId.entries()) {
    if (route.agentSocketId === agentSocketId) {
      registerAgentFailure(route.agentId);
      removeRelayRequestRoute(requestId);
    }
  }
};

export const cleanupConversationStreamSubscriptions = (conversationId: string): void => {
  for (const route of Array.from(activeStreamsByRequestId.values())) {
    if (route.conversationId === conversationId) {
      if (route.mode === "relay") {
        removeRelayRequestRoute(route.requestId);
      }
      removeActiveStreamRoute(route);
    }
  }

  for (const [requestId, route] of relayRequestsByRequestId.entries()) {
    if (route.conversationId === conversationId) {
      removeRelayRequestRoute(requestId);
    }
  }

  const idempotencyMap = relayIdempotencyByConversation.get(conversationId);
  if (idempotencyMap) {
    idempotencyMap.clear();
    relayIdempotencyByConversation.delete(conversationId);
  }
};

export const requestAgentStreamPull = (
  input: RequestAgentStreamPullInput,
): RequestAgentStreamPullResult => {
  const resolvedRequestId = input.requestId ? toRequestId(input.requestId) : null;
  const resolvedStreamId = input.streamId ? toRequestId(input.streamId) : null;
  if (!resolvedRequestId && !resolvedStreamId) {
    throw badRequest("Provide streamId or requestId to pull stream chunks");
  }

  const route = resolvedStreamId
    ? activeStreamsByStreamId.get(resolvedStreamId)
    : resolvedRequestId
      ? activeStreamsByRequestId.get(resolvedRequestId)
      : undefined;

  if (!route) {
    throw notFound("Stream route not found");
  }

  if (route.consumerSocketId !== input.consumerSocketId) {
    throw notFound("Stream route not found");
  }

  if (input.conversationId && route.conversationId !== input.conversationId) {
    throw notFound("Stream route not found");
  }

  const streamId = resolvedStreamId ?? route.streamId;
  if (!streamId) {
    throw badRequest("Stream id is not available yet for this request");
  }

  const nsp = agentsNamespace;
  if (!nsp) {
    throw serviceUnavailable("Socket bridge is not initialized");
  }

  const agentSocket = nsp.sockets.get(route.agentSocketId);
  if (!agentSocket) {
    throw serviceUnavailable("Agent socket is unavailable");
  }

  const windowSize =
    typeof input.windowSize === "number" && Number.isFinite(input.windowSize)
      ? Math.max(1, Math.floor(input.windowSize))
      : defaultStreamWindowSize;
  const traceId = randomUUID();

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
        traceId,
      },
    ),
  );

  if (route.mode === "relay") {
    relayMetrics.streamPulls += 1;
    const currentCredits = relayStreamCreditsByRequestId.get(route.requestId) ?? 0;
    let availableCredits = currentCredits + windowSize;
    relayStreamCreditsByRequestId.set(route.requestId, availableCredits);

    const buffered = relayBufferedChunksByRequestId.get(route.requestId) ?? [];
    while (availableCredits > 0 && buffered.length > 0) {
      const chunk = buffered.shift();
      if (!chunk) {
        break;
      }
      relayTotalBufferedChunks = Math.max(0, relayTotalBufferedChunks - 1);
      emitToConsumer(
        route.consumerSocketId,
        socketEvents.relayRpcChunk,
        encodePayloadFrame(chunk, { requestId: route.requestId }),
      );
      relayMetrics.chunksForwarded += 1;

      const streamIdForAudit = toRequestId(chunk.stream_id);
      const relayRoute = relayRequestsByRequestId.get(route.requestId);
      if (relayRoute) {
        void recordSocketAuditEvent({
          eventType: socketEvents.relayRpcChunk,
          actorSocketId: route.agentSocketId,
          direction: "agent_to_consumer",
          conversationId: relayRoute.conversationId,
          agentId: relayRoute.agentId,
          requestId: route.requestId,
          ...(streamIdForAudit ? { streamId: streamIdForAudit } : {}),
        });
      }

      availableCredits -= 1;
    }

    relayBufferedChunksByRequestId.set(route.requestId, buffered);
    relayStreamCreditsByRequestId.set(route.requestId, Math.max(0, availableCredits));

    if (buffered.length === 0) {
      const pendingComplete = relayPendingCompleteByRequestId.get(route.requestId);
      if (pendingComplete) {
        emitToConsumer(
          route.consumerSocketId,
          socketEvents.relayRpcComplete,
          encodePayloadFrame(pendingComplete, { requestId: route.requestId }),
        );

        const relayRoute = relayRequestsByRequestId.get(route.requestId);
        const streamIdForAudit = toRequestId(pendingComplete.stream_id);
        if (relayRoute) {
          void recordSocketAuditEvent({
            eventType: socketEvents.relayRpcComplete,
            actorSocketId: route.agentSocketId,
            direction: "agent_to_consumer",
            conversationId: relayRoute.conversationId,
            agentId: relayRoute.agentId,
            requestId: route.requestId,
            ...(streamIdForAudit ? { streamId: streamIdForAudit } : {}),
          });
        }

        relayPendingCompleteByRequestId.delete(route.requestId);
        removeRelayRequestRoute(route.requestId);
        const activeRoute = activeStreamsByRequestId.get(route.requestId);
        if (activeRoute) {
          removeActiveStreamRoute(activeRoute);
        }
      }
    }
  }

  return {
    requestId: route.requestId,
    streamId,
    windowSize,
  };
};

export const dispatchRelayRpcToAgent = (
  input: DispatchRelayRpcInput,
): DispatchRelayRpcResult => {
  cleanupExpiredIdempotency();

  const decoded = decodePayloadFrame(input.rawFramePayload);
  if (!decoded.ok) {
    throw badRequest(decoded.error.message);
  }

  const command = toRecord(decoded.value.data);
  if (!command) {
    throw badRequest("relay:rpc.request frame must contain a JSON object payload");
  }

  const conversation = conversationRegistry.findByConversationId(input.conversationId);
  if (!conversation || conversation.consumerSocketId !== input.consumerSocketId) {
    throw notFound("Conversation not found");
  }

  if (relayRequestsByRequestId.size >= relayMaxPendingRequests) {
    throw serviceUnavailable("Relay pending request capacity reached");
  }

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

  ensureAgentCircuitClosed(conversation.agentId);

  const nsp = agentsNamespace;
  if (!nsp) {
    throw serviceUnavailable("Socket bridge is not initialized");
  }

  const agentSocket = nsp.sockets.get(conversation.agentSocketId);
  if (!agentSocket) {
    throw serviceUnavailable("Agent socket is unavailable");
  }

  const clientRequestId = toRequestId(command.id);
  if (clientRequestId) {
    const idempotencyMap = getConversationIdempotencyMap(conversation.conversationId);
    const existing = idempotencyMap.get(clientRequestId);
    if (existing && existing.expiresAtMs > Date.now()) {
      relayMetrics.requestsDeduplicated += 1;
      if (existing.responseFrame) {
        emitToConsumer(conversation.consumerSocketId, socketEvents.relayRpcResponse, existing.responseFrame);
        return {
          requestId: existing.requestId,
          clientRequestId,
          deduplicated: true,
          replayed: true,
        };
      }

      return {
        requestId: existing.requestId,
        clientRequestId,
        deduplicated: true,
      };
    }
  }

  if (activeStreamsByRequestId.size >= relayMaxActiveStreams) {
    throw serviceUnavailable("Relay active stream capacity reached");
  }

  let requestId = randomUUID();
  while (
    pendingRequests.has(requestId) ||
    relayRequestsByRequestId.has(requestId) ||
    activeStreamsByRequestId.has(requestId)
  ) {
    requestId = randomUUID();
  }

  const traceId = toRequestId(decoded.value.frame.traceId) ?? randomUUID();
  const existingMeta = toRecord(command.meta) ?? {};
  const commandPayload: Record<string, unknown> = {
    ...command,
    id: requestId,
    api_version: "2.4",
    meta: {
      ...existingMeta,
      conversation_id: conversation.conversationId,
      request_id: requestId,
      ...(clientRequestId !== null ? { client_request_id: clientRequestId } : {}),
      agent_id: conversation.agentId,
      timestamp: new Date().toISOString(),
      trace_id: traceId,
    },
  };

  const timeoutHandle = setTimeout(() => {
    const route = relayRequestsByRequestId.get(requestId);
    if (!route) {
      return;
    }

    route.timedOut = true;
    relayMetrics.requestTimeouts += 1;
    registerAgentFailure(route.agentId);
    emitRelayTimeoutResponse(route);
    removeRelayRequestRoute(requestId);
    const existingStream = activeStreamsByRequestId.get(requestId);
    if (existingStream) {
      removeActiveStreamRoute(existingStream);
    }
  }, relayRequestTimeoutMs);

  const relayRoute: RelayRequestRoute = {
    requestId,
    conversationId: conversation.conversationId,
    consumerSocketId: conversation.consumerSocketId,
    agentSocketId: conversation.agentSocketId,
    agentId: conversation.agentId,
    timeoutHandle,
    createdAtMs: Date.now(),
    ...(clientRequestId !== null ? { clientRequestId } : {}),
  };

  relayRequestsByRequestId.set(requestId, relayRoute);
  relayStreamCreditsByRequestId.set(requestId, 0);
  relayBufferedChunksByRequestId.set(requestId, []);
  upsertActiveStreamRoute({
    requestId,
    agentSocketId: conversation.agentSocketId,
    streamHandlers: createRelayStreamHandlers(relayRoute),
  });

  try {
    agentSocket.emit(
      socketEvents.rpcRequest,
      encodePayloadFrame(commandPayload, {
        requestId,
        traceId,
      }),
    );
  } catch (error: unknown) {
    removeRelayRequestRoute(requestId);
    const existingStream = activeStreamsByRequestId.get(requestId);
    if (existingStream && existingStream.agentSocketId === conversation.agentSocketId) {
      removeActiveStreamRoute(existingStream);
    }
    registerAgentFailure(conversation.agentId);
    throw error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request");
  }

  if (clientRequestId) {
    const idempotencyMap = getConversationIdempotencyMap(conversation.conversationId);
    idempotencyMap.set(clientRequestId, {
      requestId,
      expiresAtMs: Date.now() + relayIdempotencyTtlMs,
    });
  }

  relayMetrics.requestsAccepted += 1;
  conversationRegistry.touch(conversation.conversationId);

  return {
    requestId,
    ...(clientRequestId !== null ? { clientRequestId } : {}),
  };
};

export const requestRelayStreamPull = (
  input: RequestRelayStreamPullInput,
): RequestAgentStreamPullResult => {
  const decoded = decodePayloadFrame(input.rawFramePayload);
  if (!decoded.ok) {
    throw badRequest(decoded.error.message);
  }

  const payload = toRecord(decoded.value.data);
  if (!payload) {
    throw badRequest("relay:rpc.stream.pull frame must contain a JSON object payload");
  }

  const conversation = conversationRegistry.findByConversationId(input.conversationId);
  if (!conversation || conversation.consumerSocketId !== input.consumerSocketId) {
    throw notFound("Conversation not found");
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

  const result = requestAgentStreamPull({
    consumerSocketId: input.consumerSocketId,
    conversationId: input.conversationId,
    ...(requestId ? { requestId } : {}),
    ...(streamId ? { streamId } : {}),
    ...(
      typeof payload.window_size === "number" && Number.isFinite(payload.window_size)
        ? { windowSize: payload.window_size }
        : {}
    ),
  });

  conversationRegistry.touch(conversation.conversationId);
  return result;
};

export const dispatchRpcCommandToAgent = async (
  input: DispatchRpcCommandInput,
): Promise<DispatchRpcCommandResult> => {
  ensureAgentCircuitClosed(input.agentId);

  const nsp = agentsNamespace;
  if (!nsp) {
    throw serviceUnavailable("Socket bridge is not initialized");
  }

  const registeredAgent = agentRegistry.findByAgentId(input.agentId);
  if (!registeredAgent) {
    if (agentRegistry.hasKnownAgentId(input.agentId)) {
      throw serviceUnavailable(`Agent ${input.agentId} is disconnected`);
    }

    throw notFound(`Agent ${input.agentId}`);
  }

  const agentSocket = nsp.sockets.get(registeredAgent.socketId);
  if (!agentSocket) {
    throw serviceUnavailable("Agent socket is unavailable");
  }

  const command = toRecord(input.command);
  if (!command) {
    throw badRequest("Command must be a JSON object");
  }

  const explicitRequestId = toRequestId(command.id);
  const requestId = explicitRequestId ?? randomUUID();
  const traceId = randomUUID();
  const baseCommand = explicitRequestId ? command : { ...command, id: requestId };
  const existingMeta = toRecord(command.meta) ?? {};
  const commandPayload = {
    ...baseCommand,
    api_version: "2.4",
    meta: {
      ...existingMeta,
      request_id: requestId,
      agent_id: input.agentId,
      timestamp: new Date().toISOString(),
      trace_id: traceId,
    },
  };
  const timeoutMs = input.timeoutMs ?? defaultRequestTimeoutMs;
  if (pendingRequests.has(requestId) || activeStreamsByRequestId.has(requestId)) {
    throw badRequest("A request with this JSON-RPC id is already pending");
  }

  const response = await new Promise<unknown>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const pending = pendingRequests.get(requestId);
      const hadAck = pending?.acked ?? false;
      pendingRequests.delete(requestId);
      const existingStream = activeStreamsByRequestId.get(requestId);
      if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
        removeActiveStreamRoute(existingStream);
      }
      if (!hadAck) {
        logger.info("rpc_timeout_without_ack", { requestId, socketId: registeredAgent.socketId });
      }
      registerAgentFailure(input.agentId);
      reject(serviceUnavailable("Timed out waiting for agent response"));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      socketId: registeredAgent.socketId,
      agentId: input.agentId,
      resolve,
      timeoutHandle,
      ...(input.streamHandlers ? { streamHandlers: input.streamHandlers } : {}),
      acked: false,
    });

    if (input.streamHandlers) {
      upsertActiveStreamRoute({
        requestId,
        agentSocketId: registeredAgent.socketId,
        streamHandlers: input.streamHandlers,
      });
    }

    try {
      agentSocket.emit(
        socketEvents.rpcRequest,
        encodePayloadFrame(commandPayload, {
          requestId,
          traceId,
        }),
      );
    } catch (error: unknown) {
      clearTimeout(timeoutHandle);
      pendingRequests.delete(requestId);
      const existingStream = activeStreamsByRequestId.get(requestId);
      if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
        removeActiveStreamRoute(existingStream);
      }
      registerAgentFailure(input.agentId);
      reject(error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request"));
    }
  });

  return {
    requestId,
    response,
  };
};
