import { randomUUID } from "node:crypto";

import type { Namespace } from "socket.io";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import { badRequest, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import type {
  BridgeBatchCommand,
  BridgeCommand,
} from "../../../shared/validators/agent_command";
import { bridgeCommandSchema } from "../../../shared/validators/agent_command";
import { normalizeCommandForAgent } from "../../../application/agent_commands/command_transformers";
import { logger } from "../../../shared/utils/logger";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  finishPayloadFrameEnvelope,
  preencodePayloadFrameJson,
} from "../../../shared/utils/payload_frame";
import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
  type LatencyRingBuffer,
} from "../../../shared/utils/latency_ring_buffer";
import { percentile } from "../../../shared/utils/percentile";
import { agentRegistry } from "./agent_registry";
import { conversationRegistry } from "./conversation_registry";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface PendingRequest {
  readonly primaryRequestId: string;
  readonly correlationIds: readonly string[];
  readonly socketId: string;
  readonly agentId: string;
  readonly createdAtMs: number;
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
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
  readonly command: BridgeCommand;
  readonly timeoutMs?: number;
  readonly streamHandlers?: StreamEventHandlers;
  readonly signal?: AbortSignal;
}

interface DispatchRpcCommandResponseResult {
  readonly requestId: string;
  readonly response: unknown;
}

interface DispatchRpcCommandNotificationResult {
  readonly requestId: string;
  readonly notification: true;
  readonly acceptedCommands: number;
}

export type DispatchRpcCommandResult =
  | DispatchRpcCommandResponseResult
  | DispatchRpcCommandNotificationResult;

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

interface AgentLatencyStats {
  count: number;
  totalMs: number;
  maxMs: number;
  ring: LatencyRingBuffer;
}

interface AgentQueueWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly enqueuedAtMs: number;
  readonly timeoutHandle: NodeJS.Timeout;
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
const relayIdempotencyCleanupIntervalMs = env.socketRelayIdempotencyCleanupIntervalMs;
const relayCircuitFailureThreshold = env.socketRelayCircuitFailureThreshold;
const relayCircuitOpenMs = env.socketRelayCircuitOpenMs;
const restAgentMaxInflight = env.socketRestAgentMaxInflight;
const restAgentMaxQueue = env.socketRestAgentMaxQueue;
const restAgentQueueWaitMs = env.socketRestAgentQueueWaitMs;
let agentsNamespace: Namespace | null = null;
let consumersNamespace: Namespace | null = null;
const pendingRequests = new Map<string, PendingRequest>();
let pendingRequestCount = 0;
const agentInflightById = new Map<string, number>();
const agentQueueById = new Map<string, AgentQueueWaiter[]>();
const activeStreamsByRequestId = new Map<string, ActiveStreamRoute>();
const activeStreamsByStreamId = new Map<string, ActiveStreamRoute>();
const activeStreamRequestIdsByConversation = new Map<string, Set<string>>();
const relayRequestsByRequestId = new Map<string, RelayRequestRoute>();
const relayIdempotencyByConversation = new Map<
  string,
  Map<string, { requestId: string; expiresAtMs: number; responseFrame?: unknown }>
>();
const relayPendingCountByConversation = new Map<string, number>();
const relayPendingCountByConsumer = new Map<string, number>();
const relayRequestIdsByConversation = new Map<string, Set<string>>();
const relayRequestIdsByConsumer = new Map<string, Set<string>>();
const relayRequestIdsByAgent = new Map<string, Set<string>>();
const streamRequestIdsByConsumer = new Map<string, Set<string>>();
const streamRequestIdsByAgent = new Map<string, Set<string>>();
const relayStreamCreditsByRequestId = new Map<string, number>();
const relayBufferedChunksByRequestId = new Map<string, Record<string, unknown>[]>();
const relayPendingCompleteByRequestId = new Map<string, Record<string, unknown>>();
let relayTotalBufferedChunks = 0;
const relayCircuitByAgentId = new Map<string, { failures: number; openUntilMs: number }>();
const latencySamplesPerAgent = 256;
const latencyByAgentId = new Map<string, AgentLatencyStats>();
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
  restPendingRejected: 0,
};
let relayMetricsTimer: NodeJS.Timeout | null = null;
let idempotencyCleanupTimer: NodeJS.Timeout | null = null;
let rpcFrameDecodeFailureCount = 0;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const withAppendedMessage = (base: string, extra: string): string =>
  extra.trim() === "" ? base : `${base}. ${extra}`;

const serviceUnavailableWithRetry = (
  message: string,
  retryAfterMs: number,
): AppError => {
  return new AppError(message, {
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
    details: { retry_after_ms: Math.max(0, Math.floor(retryAfterMs)) },
  });
};

const incrementCounter = (counterMap: Map<string, number>, key: string): void => {
  counterMap.set(key, (counterMap.get(key) ?? 0) + 1);
};

const decrementCounter = (counterMap: Map<string, number>, key: string): void => {
  const nextValue = (counterMap.get(key) ?? 0) - 1;
  if (nextValue > 0) {
    counterMap.set(key, nextValue);
    return;
  }

  counterMap.delete(key);
};

const addToIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  index.set(key, new Set([value]));
};

const removeFromIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (!existing) {
    return;
  }

  existing.delete(value);
  if (existing.size === 0) {
    index.delete(key);
  }
};

const logRpcFrameDecodeFailure = (input: {
  readonly eventName: string;
  readonly socketId: string;
  readonly reason: string;
}): void => {
  rpcFrameDecodeFailureCount += 1;

  // Keep logs useful under malformed frame floods: first 5 and then each 100th.
  if (rpcFrameDecodeFailureCount <= 5 || rpcFrameDecodeFailureCount % 100 === 0) {
    logger.warn("rpc_frame_decode_failed", {
      event: input.eventName,
      socketId: input.socketId,
      reason: input.reason,
      count: rpcFrameDecodeFailureCount,
    });
  }
};

const getAgentInflight = (agentId: string): number => agentInflightById.get(agentId) ?? 0;

const setAgentInflight = (agentId: string, value: number): void => {
  if (value <= 0) {
    agentInflightById.delete(agentId);
    return;
  }
  agentInflightById.set(agentId, value);
};

const drainAgentQueue = (agentId: string): void => {
  const inflight = getAgentInflight(agentId);
  if (inflight >= restAgentMaxInflight) {
    return;
  }

  const queue = agentQueueById.get(agentId);
  if (!queue || queue.length === 0) {
    if (queue && queue.length === 0) {
      agentQueueById.delete(agentId);
    }
    return;
  }

  const next = queue.shift();
  if (queue.length === 0) {
    agentQueueById.delete(agentId);
  } else {
    agentQueueById.set(agentId, queue);
  }

  if (!next) {
    return;
  }

  clearTimeout(next.timeoutHandle);
  setAgentInflight(agentId, inflight + 1);
  next.resolve();
};

const releaseAgentDispatchSlot = (agentId: string): void => {
  const current = getAgentInflight(agentId);
  setAgentInflight(agentId, current - 1);
  drainAgentQueue(agentId);
};

const removeQueuedWaiter = (agentId: string, waiter: AgentQueueWaiter): void => {
  const queue = agentQueueById.get(agentId);
  if (!queue || queue.length === 0) {
    return;
  }

  const index = queue.indexOf(waiter);
  if (index < 0) {
    return;
  }

  queue.splice(index, 1);
  if (queue.length === 0) {
    agentQueueById.delete(agentId);
  } else {
    agentQueueById.set(agentId, queue);
  }
};

const acquireAgentDispatchSlot = async (
  agentId: string,
  signal?: AbortSignal,
): Promise<() => void> => {
  if (signal?.aborted) {
    throw serviceUnavailable("HTTP request aborted by client");
  }

  const inflight = getAgentInflight(agentId);
  if (inflight < restAgentMaxInflight) {
    setAgentInflight(agentId, inflight + 1);
    return () => {
      releaseAgentDispatchSlot(agentId);
    };
  }

  const queue = agentQueueById.get(agentId) ?? [];
  if (queue.length >= restAgentMaxQueue) {
    relayMetrics.restPendingRejected += 1;
    throw serviceUnavailableWithRetry(
      withAppendedMessage("Agent is overloaded", "queue is full"),
      restAgentQueueWaitMs,
    );
  }

  const release = await new Promise<() => void>((resolve, reject) => {
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signalListener) {
        signal?.removeEventListener("abort", signalListener);
      }
      reject(error);
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signalListener) {
        signal?.removeEventListener("abort", signalListener);
      }
      resolve(() => {
        releaseAgentDispatchSlot(agentId);
      });
    };

    const timeoutHandle = setTimeout(() => {
      removeQueuedWaiter(agentId, waiter);
      relayMetrics.restPendingRejected += 1;
      rejectOnce(
        serviceUnavailableWithRetry(
          withAppendedMessage("Agent is overloaded", "queue wait timeout"),
          restAgentQueueWaitMs,
        ),
      );
    }, restAgentQueueWaitMs);

    const waiter: AgentQueueWaiter = {
      resolve: resolveOnce,
      reject: rejectOnce,
      enqueuedAtMs: Date.now(),
      timeoutHandle,
    };

    const signalListener = signal
      ? () => {
          clearTimeout(timeoutHandle);
          removeQueuedWaiter(agentId, waiter);
          rejectOnce(serviceUnavailable("HTTP request aborted by client"));
        }
      : null;

    queue.push(waiter);
    agentQueueById.set(agentId, queue);
    if (signal && signalListener) {
      signal.addEventListener("abort", signalListener, { once: true });
    }
  });

  return release;
};

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
  return relayPendingCountByConversation.get(conversationId) ?? 0;
};

const getRelayPendingRequestCountForConsumer = (consumerSocketId: string): number => {
  return relayPendingCountByConsumer.get(consumerSocketId) ?? 0;
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

const observeAgentLatency = (agentId: string, elapsedMs: number): void => {
  const safeElapsedMs = Math.max(0, elapsedMs);
  const existing = latencyByAgentId.get(agentId);
  if (existing) {
    existing.count += 1;
    existing.totalMs += safeElapsedMs;
    existing.maxMs = Math.max(existing.maxMs, safeElapsedMs);
    pushLatencyRingBuffer(existing.ring, safeElapsedMs);
    latencyByAgentId.set(agentId, existing);
    return;
  }

  const ring = createLatencyRingBuffer(latencySamplesPerAgent);
  pushLatencyRingBuffer(ring, safeElapsedMs);
  latencyByAgentId.set(agentId, {
    count: 1,
    totalMs: safeElapsedMs,
    maxMs: safeElapsedMs,
    ring,
  });
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
    const snapshot = getRelayMetricsSnapshot();
    logger.info("socket_relay_metrics", {
      ...snapshot.counters,
      ...snapshot.gauges,
    });
  }, env.socketRelayMetricsLogIntervalMs);
  relayMetricsTimer.unref?.();
};

const scheduleIdempotencyCleanupTimer = (): void => {
  if (idempotencyCleanupTimer) {
    return;
  }

  idempotencyCleanupTimer = setInterval(cleanupExpiredIdempotency, relayIdempotencyCleanupIntervalMs);
  idempotencyCleanupTimer.unref?.();
};

export const stopRelayMetricsLogger = (): void => {
  if (!relayMetricsTimer) {
    return;
  }
  clearInterval(relayMetricsTimer);
  relayMetricsTimer = null;
};

const stopIdempotencyCleanupTimer = (): void => {
  if (!idempotencyCleanupTimer) {
    return;
  }
  clearInterval(idempotencyCleanupTimer);
  idempotencyCleanupTimer = null;
};

export const getRelayMetricsSnapshot = (): {
  readonly counters: {
    readonly requestsAccepted: number;
    readonly requestsDeduplicated: number;
    readonly responsesForwarded: number;
    readonly chunksForwarded: number;
    readonly chunksBuffered: number;
    readonly chunksDropped: number;
    readonly streamPulls: number;
    readonly requestTimeouts: number;
    readonly circuitOpenRejects: number;
    readonly restPendingRejected: number;
    readonly rpcFrameDecodeFailed: number;
  };
  readonly gauges: {
    readonly pendingRelayRequests: number;
    readonly pendingRestRequests: number;
    readonly activeStreams: number;
    readonly bufferedChunks: number;
    readonly openCircuits: number;
  };
  readonly latencyByAgent: readonly {
    readonly agentId: string;
    readonly count: number;
    readonly avgMs: number;
    readonly maxMs: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  }[];
} => {
  const openCircuits = Array.from(relayCircuitByAgentId.values()).filter(
    (state) => state.openUntilMs > Date.now(),
  ).length;

  const latencyByAgent = Array.from(latencyByAgentId.entries()).map(([agentId, stats]) => {
    const sampleSlice = latencyRingBufferValues(stats.ring);
    return {
      agentId,
      count: stats.count,
      avgMs: stats.count > 0 ? Number((stats.totalMs / stats.count).toFixed(2)) : 0,
      maxMs: stats.maxMs,
      p95Ms: Number(percentile(sampleSlice, 95).toFixed(2)),
      p99Ms: Number(percentile(sampleSlice, 99).toFixed(2)),
    };
  });

  return {
    counters: {
      ...relayMetrics,
      rpcFrameDecodeFailed: rpcFrameDecodeFailureCount,
    },
    gauges: {
      pendingRelayRequests: relayRequestsByRequestId.size,
      pendingRestRequests: pendingRequestCount,
      activeStreams: activeStreamsByRequestId.size,
      bufferedChunks: relayTotalBufferedChunks,
      openCircuits,
    },
    latencyByAgent,
  };
};

const pickResponseIds = (payload: unknown): readonly string[] => {
  if (Array.isArray(payload)) {
    const ids: string[] = [];
    for (const item of payload) {
      const record = toRecord(item);
      if (!record) {
        continue;
      }
      const id = toRequestId(record.id);
      if (!id) {
        continue;
      }
      ids.push(id);
    }
    return ids;
  }

  const record = toRecord(payload);
  if (!record) {
    return [];
  }

  const id = toRequestId(record.id);
  return id ? [id] : [];
};

const isBatchCommand = (command: BridgeCommand): command is BridgeBatchCommand => {
  return Array.isArray(command);
};

const toCorrelationIds = (command: BridgeCommand): readonly string[] => {
  if (isBatchCommand(command)) {
    const ids: string[] = [];
    for (const item of command) {
      const id = toRequestId(item.id);
      if (id) {
        ids.push(id);
      }
    }
    return ids;
  }

  const singleId = toRequestId(command.id);
  return singleId ? [singleId] : [];
};

const withBridgeMeta = (
  command: BridgeCommand,
  input: { readonly requestId: string; readonly agentId: string; readonly traceId: string; readonly timestamp: string },
): BridgeCommand => {
  if (isBatchCommand(command)) {
    return command.map((item) => {
      const existingMeta = toRecord(item.meta) ?? {};
      const itemRequestId = toRequestId(item.id) ?? input.requestId;
      return {
        ...item,
        api_version: "2.5",
        meta: {
          ...existingMeta,
          request_id: itemRequestId,
          agent_id: input.agentId,
          timestamp: input.timestamp,
          trace_id: input.traceId,
        },
      };
    });
  }

  const existingMeta = toRecord(command.meta) ?? {};
  return {
    ...command,
    api_version: "2.5",
    meta: {
      ...existingMeta,
      request_id: input.requestId,
      agent_id: input.agentId,
      timestamp: input.timestamp,
      trace_id: input.traceId,
    },
  };
};

const registerPendingRequest = (pending: PendingRequest): void => {
  for (const requestId of pending.correlationIds) {
    pendingRequests.set(requestId, pending);
  }
  pendingRequestCount += 1;
};

const clearPendingRequest = (pending: PendingRequest): void => {
  let removed = false;
  for (const requestId of pending.correlationIds) {
    const existing = pendingRequests.get(requestId);
    if (existing === pending) {
      pendingRequests.delete(requestId);
      removed = true;
    }
  }

  if (removed) {
    pendingRequestCount = Math.max(0, pendingRequestCount - 1);
  }
};

const findPendingRequestByIds = (
  socketId: string,
  ids: readonly string[],
): PendingRequest | null => {
  for (const id of ids) {
    const pending = pendingRequests.get(id);
    if (pending && pending.socketId === socketId) {
      return pending;
    }
  }
  return null;
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
  if (route.conversationId) {
    removeFromIndex(activeStreamRequestIdsByConversation, route.conversationId, route.requestId);
  }
  removeFromIndex(streamRequestIdsByConsumer, route.consumerSocketId, route.requestId);
  removeFromIndex(streamRequestIdsByAgent, route.agentSocketId, route.requestId);
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

  addToIndex(streamRequestIdsByConsumer, route.consumerSocketId, route.requestId);
  addToIndex(streamRequestIdsByAgent, route.agentSocketId, route.requestId);

  activeStreamsByRequestId.set(route.requestId, route);
  if (route.streamId) {
    activeStreamsByStreamId.set(route.streamId, route);
  }
  if (route.conversationId) {
    addToIndex(activeStreamRequestIdsByConversation, route.conversationId, route.requestId);
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
  scheduleIdempotencyCleanupTimer();
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
  decrementCounter(relayPendingCountByConversation, route.conversationId);
  decrementCounter(relayPendingCountByConsumer, route.consumerSocketId);
  removeFromIndex(relayRequestIdsByConversation, route.conversationId, requestId);
  removeFromIndex(relayRequestIdsByConsumer, route.consumerSocketId, requestId);
  removeFromIndex(relayRequestIdsByAgent, route.agentSocketId, requestId);
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
    logRpcFrameDecodeFailure({
      eventName: socketEvents.rpcResponse,
      socketId,
      reason: decoded.error.message,
    });
    return;
  }

  const frameRequestId = toRequestId(decoded.value.frame.requestId);
  const responseIds = pickResponseIds(decoded.value.data);
  const candidateIds = Array.from(
    new Set([
      ...responseIds,
      ...(frameRequestId ? [frameRequestId] : []),
    ]),
  );

  if (candidateIds.length === 0) {
    return;
  }

  const streamId = extractStreamIdFromRpcResponse(decoded.value.data);
  const pendingRequest = findPendingRequestByIds(socketId, candidateIds);
  if (pendingRequest) {
    const pendingRequestId = pendingRequest.primaryRequestId;
    if (pendingRequest.streamHandlers) {
      if (streamId) {
        upsertActiveStreamRoute({
          requestId: pendingRequestId,
          agentSocketId: socketId,
          streamHandlers: pendingRequest.streamHandlers,
          streamId,
        });
        logger.debug("rpc_stream_registered", { requestId: pendingRequestId, streamId, socketId });
      } else {
        const existingStream = activeStreamsByRequestId.get(pendingRequestId);
        if (existingStream && existingStream.agentSocketId === socketId) {
          removeActiveStreamRoute(existingStream);
        }
      }
    }

    if (!pendingRequest.acked) {
      logger.info("rpc_response_received_without_ack", { requestId: pendingRequestId, socketId });
    }

    registerAgentSuccess(pendingRequest.agentId);
    observeAgentLatency(pendingRequest.agentId, Date.now() - pendingRequest.createdAtMs);
    clearTimeout(pendingRequest.timeoutHandle);
    clearPendingRequest(pendingRequest);
    pendingRequest.resolve(decoded.value.data);
  }

  const relayRoute = candidateIds
    .map((id) => relayRequestsByRequestId.get(id))
    .find((route): route is RelayRequestRoute => route !== undefined && route.agentSocketId === socketId);

  if (!relayRoute) {
    return;
  }

  const responseId = relayRoute.requestId;

  const responseFrame = encodePayloadFrame(decoded.value.data, { requestId: responseId });
  emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, responseFrame);
  relayMetrics.responsesForwarded += 1;
  observeAgentLatency(relayRoute.agentId, Date.now() - relayRoute.createdAtMs);
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
    logRpcFrameDecodeFailure({
      eventName: socketEvents.rpcChunk,
      socketId,
      reason: decoded.error.message,
    });
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
    logRpcFrameDecodeFailure({
      eventName: socketEvents.rpcComplete,
      socketId,
      reason: decoded.error.message,
    });
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
    logRpcFrameDecodeFailure({
      eventName: socketEvents.rpcRequestAck,
      socketId,
      reason: decoded.error.message,
    });
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
    logger.debug("rpc_ack_received", { requestId, socketId });
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
    logRpcFrameDecodeFailure({
      eventName: socketEvents.rpcBatchAck,
      socketId,
      reason: decoded.error.message,
    });
    return;
  }

  const data = toRecord(decoded.value.data);
  if (!data) {
    return;
  }

  const requestIds = Array.isArray(data.request_ids)
    ? (data.request_ids as unknown[]).map((id) => toRequestId(id)).filter((id): id is string => id !== null)
    : [];

  const preencodedBatchAck =
    requestIds.length > 1 ? preencodePayloadFrameJson(data) : null;

  let ackedCount = 0;
  for (const requestId of requestIds) {
    const pending = pendingRequests.get(requestId);
    if (pending && pending.socketId === socketId) {
      pending.acked = true;
      ackedCount++;
    }

    const relayRoute = relayRequestsByRequestId.get(requestId);
    if (relayRoute && relayRoute.agentSocketId === socketId) {
      const frame =
        preencodedBatchAck !== null
          ? finishPayloadFrameEnvelope(preencodedBatchAck, { requestId })
          : encodePayloadFrame(data, { requestId });
      emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcBatchAck, frame);
    }
  }
  if (ackedCount > 0) {
    logger.debug("rpc_batch_ack_received", { requestIds: requestIds.slice(0, 5), ackedCount, socketId });
  }
};

export const cleanupConsumerStreamSubscriptions = (consumerSocketId: string): void => {
  const streamIds = Array.from(streamRequestIdsByConsumer.get(consumerSocketId) ?? []);
  for (const requestId of streamIds) {
    const route = activeStreamsByRequestId.get(requestId);
    if (!route || route.consumerSocketId !== consumerSocketId) {
      continue;
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
    }
    removeActiveStreamRoute(route);
  }

  const relayIds = Array.from(relayRequestIdsByConsumer.get(consumerSocketId) ?? []);
  for (const requestId of relayIds) {
    removeRelayRequestRoute(requestId);
  }
};

export const cleanupAgentStreamSubscriptions = (agentSocketId: string): void => {
  const streamIds = Array.from(streamRequestIdsByAgent.get(agentSocketId) ?? []);
  for (const requestId of streamIds) {
    const route = activeStreamsByRequestId.get(requestId);
    if (!route || route.agentSocketId !== agentSocketId) {
      continue;
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
    }
    removeActiveStreamRoute(route);
  }

  const relayAgentIds = Array.from(relayRequestIdsByAgent.get(agentSocketId) ?? []);
  for (const requestId of relayAgentIds) {
    const route = relayRequestsByRequestId.get(requestId);
    if (!route || route.agentSocketId !== agentSocketId) {
      continue;
    }
    registerAgentFailure(route.agentId);
    removeRelayRequestRoute(requestId);
  }
};

export const cleanupPendingRequestsForAgentSocket = (agentSocketId: string): number => {
  const uniquePending = new Set<PendingRequest>();
  let cleaned = 0;

  for (const pending of pendingRequests.values()) {
    if (pending.socketId === agentSocketId) {
      uniquePending.add(pending);
    }
  }

  for (const pending of uniquePending) {
    clearTimeout(pending.timeoutHandle);
    clearPendingRequest(pending);
    const existingStream = activeStreamsByRequestId.get(pending.primaryRequestId);
    if (existingStream && existingStream.agentSocketId === agentSocketId) {
      removeActiveStreamRoute(existingStream);
    }
    registerAgentFailure(pending.agentId);
    pending.reject(serviceUnavailable("Agent disconnected while waiting for response"));
    cleaned += 1;
  }

  return cleaned;
};

export const cleanupConversationStreamSubscriptions = (conversationId: string): void => {
  const streamRequestIds = Array.from(activeStreamRequestIdsByConversation.get(conversationId) ?? []);
  for (const requestId of streamRequestIds) {
    const route = activeStreamsByRequestId.get(requestId);
    if (!route) {
      continue;
    }
    if (route.mode === "relay") {
      removeRelayRequestRoute(route.requestId);
    }
    removeActiveStreamRoute(route);
  }

  const relayRequestIds = Array.from(relayRequestIdsByConversation.get(conversationId) ?? []);
  for (const requestId of relayRequestIds) {
    removeRelayRequestRoute(requestId);
  }

  const idempotencyMap = relayIdempotencyByConversation.get(conversationId);
  if (idempotencyMap) {
    idempotencyMap.clear();
    relayIdempotencyByConversation.delete(conversationId);
  }
};

export const resetSocketBridgeState = (): void => {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeoutHandle);
  }
  pendingRequests.clear();
  pendingRequestCount = 0;

  for (const route of relayRequestsByRequestId.values()) {
    clearTimeout(route.timeoutHandle);
  }
  relayRequestsByRequestId.clear();

  activeStreamsByRequestId.clear();
  activeStreamsByStreamId.clear();
  activeStreamRequestIdsByConversation.clear();
  relayIdempotencyByConversation.clear();
  relayPendingCountByConversation.clear();
  relayPendingCountByConsumer.clear();
  relayRequestIdsByConversation.clear();
  relayRequestIdsByConsumer.clear();
  relayRequestIdsByAgent.clear();
  streamRequestIdsByConsumer.clear();
  streamRequestIdsByAgent.clear();
  relayStreamCreditsByRequestId.clear();
  relayBufferedChunksByRequestId.clear();
  relayPendingCompleteByRequestId.clear();
  relayCircuitByAgentId.clear();
  latencyByAgentId.clear();
  relayTotalBufferedChunks = 0;
  agentInflightById.clear();
  for (const queue of agentQueueById.values()) {
    for (const waiter of queue) {
      clearTimeout(waiter.timeoutHandle);
      waiter.reject(serviceUnavailable("REST agent queue has been reset"));
    }
  }
  agentQueueById.clear();

  relayMetrics.requestsAccepted = 0;
  relayMetrics.requestsDeduplicated = 0;
  relayMetrics.responsesForwarded = 0;
  relayMetrics.chunksForwarded = 0;
  relayMetrics.chunksBuffered = 0;
  relayMetrics.chunksDropped = 0;
  relayMetrics.streamPulls = 0;
  relayMetrics.requestTimeouts = 0;
  relayMetrics.circuitOpenRejects = 0;
  relayMetrics.restPendingRejected = 0;
  rpcFrameDecodeFailureCount = 0;

  stopRelayMetricsLogger();
  stopIdempotencyCleanupTimer();
  agentsNamespace = null;
  consumersNamespace = null;
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
  const decoded = decodePayloadFrame(input.rawFramePayload);
  if (!decoded.ok) {
    logRpcFrameDecodeFailure({
      eventName: socketEvents.relayRpcRequest,
      socketId: input.consumerSocketId,
      reason: decoded.error.message,
    });
    throw badRequest(decoded.error.message);
  }

  const rawCommand = toRecord(decoded.value.data);
  if (!rawCommand) {
    throw badRequest("relay:rpc.request frame must contain a JSON object payload");
  }

  const parsed = bridgeCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue ? `${firstIssue.path.join(".") || "command"}: ${firstIssue.message}` : "Invalid RPC command";
    throw badRequest(message);
  }

  const command = parsed.data;
  if (Array.isArray(command)) {
    throw badRequest("relay:rpc.request does not support batch; send a single JSON-RPC request");
  }

  const normalizedCommand = normalizeCommandForAgent(command);

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

  const cmdRecord = normalizedCommand as Record<string, unknown>;
  const clientRequestId = toRequestId(cmdRecord.id);
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

  const requestId = randomUUID();

  const traceId = toRequestId(decoded.value.frame.traceId) ?? randomUUID();
  const existingMeta = toRecord(cmdRecord.meta) ?? {};
  const commandPayload: Record<string, unknown> = {
    ...normalizedCommand,
    id: requestId,
    api_version: "2.5",
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
  incrementCounter(relayPendingCountByConversation, relayRoute.conversationId);
  incrementCounter(relayPendingCountByConsumer, relayRoute.consumerSocketId);
  addToIndex(relayRequestIdsByConversation, relayRoute.conversationId, relayRoute.requestId);
  addToIndex(relayRequestIdsByConsumer, relayRoute.consumerSocketId, relayRoute.requestId);
  addToIndex(relayRequestIdsByAgent, relayRoute.agentSocketId, relayRoute.requestId);
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
  if (input.signal?.aborted) {
    throw serviceUnavailable("HTTP request aborted by client");
  }

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
  ensureAgentCircuitClosed(input.agentId);

  if (!isRecord(input.command) && !Array.isArray(input.command)) {
    throw badRequest("Command must be a JSON object or JSON-RPC batch array");
  }

  const command = input.command;
  const correlationIds = toCorrelationIds(command);
  const firstCorrelationId = correlationIds.at(0);
  const requestId = !isBatchCommand(command) && firstCorrelationId ? firstCorrelationId : randomUUID();
  const traceId = randomUUID();
  const commandPayload = withBridgeMeta(command, {
    requestId,
    agentId: input.agentId,
    traceId,
    timestamp: new Date().toISOString(),
  });
  const timeoutMs = input.timeoutMs ?? defaultRequestTimeoutMs;

  for (const correlationId of correlationIds) {
    if (
      pendingRequests.has(correlationId) ||
      activeStreamsByRequestId.has(correlationId) ||
      relayRequestsByRequestId.has(correlationId)
    ) {
      throw badRequest("A request with this JSON-RPC id is already pending");
    }
  }

  if (correlationIds.length === 0) {
    const releaseAgentSlot = await acquireAgentDispatchSlot(input.agentId, input.signal);
    try {
      agentSocket.emit(
        socketEvents.rpcRequest,
        encodePayloadFrame(commandPayload, {
          requestId,
          traceId,
        }),
      );

      return {
        requestId,
        notification: true,
        acceptedCommands: isBatchCommand(command) ? command.length : 1,
      };
    } catch (error: unknown) {
      registerAgentFailure(input.agentId);
      throw error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request");
    } finally {
      releaseAgentSlot();
    }
  }

  if (pendingRequestCount >= env.socketRestMaxPendingRequests) {
    relayMetrics.restPendingRejected += 1;
    throw serviceUnavailableWithRetry(
      "REST bridge pending request capacity reached",
      restAgentQueueWaitMs,
    );
  }

  const releaseAgentSlot = await acquireAgentDispatchSlot(input.agentId, input.signal);
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let signalListener: (() => void) | null = null;

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (signalListener) {
          input.signal?.removeEventListener("abort", signalListener);
        }
        reject(error);
      };

      const resolveOnce = (payload: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (signalListener) {
          input.signal?.removeEventListener("abort", signalListener);
        }
        resolve(payload);
      };

      const timeoutHandle = setTimeout(() => {
        const hadAck = pendingRequest.acked;
        clearPendingRequest(pendingRequest);
        const existingStream = activeStreamsByRequestId.get(pendingRequest.primaryRequestId);
        if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
          removeActiveStreamRoute(existingStream);
        }
        if (!hadAck) {
          logger.info("rpc_timeout_without_ack", {
            requestId: pendingRequest.primaryRequestId,
            socketId: registeredAgent.socketId,
          });
        }
        registerAgentFailure(input.agentId);
        rejectOnce(serviceUnavailable("Timed out waiting for agent response"));
      }, timeoutMs);

      const pendingRequest: PendingRequest = {
        primaryRequestId: requestId,
        correlationIds,
        socketId: registeredAgent.socketId,
        agentId: input.agentId,
        createdAtMs: Date.now(),
        resolve: resolveOnce,
        reject: rejectOnce,
        timeoutHandle,
        ...(
          !isBatchCommand(command) &&
          command.method === "sql.execute" &&
          input.streamHandlers &&
          correlationIds.length === 1
            ? { streamHandlers: input.streamHandlers }
            : {}
        ),
        acked: false,
      };

      signalListener = () => {
        clearTimeout(timeoutHandle);
        clearPendingRequest(pendingRequest);
        const existingStream = activeStreamsByRequestId.get(pendingRequest.primaryRequestId);
        if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
          removeActiveStreamRoute(existingStream);
        }
        rejectOnce(serviceUnavailable("HTTP request aborted by client"));
      };

      if (input.signal) {
        input.signal.addEventListener("abort", signalListener, { once: true });
        if (input.signal.aborted) {
          signalListener();
          return;
        }
      }

      registerPendingRequest(pendingRequest);

      if (pendingRequest.streamHandlers) {
        upsertActiveStreamRoute({
          requestId,
          agentSocketId: registeredAgent.socketId,
          streamHandlers: pendingRequest.streamHandlers,
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
        clearPendingRequest(pendingRequest);
        const existingStream = activeStreamsByRequestId.get(requestId);
        if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
          removeActiveStreamRoute(existingStream);
        }
        registerAgentFailure(input.agentId);
        rejectOnce(error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request"));
      }
    });

    return {
      requestId,
      response,
    };
  } finally {
    releaseAgentSlot();
  }
};
