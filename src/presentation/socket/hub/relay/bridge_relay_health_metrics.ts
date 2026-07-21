import { env } from "../../../../shared/config/env";
import { serviceUnavailableWithRetry } from "../../../../shared/errors/http_errors";
import { logger } from "../../../../shared/utils/logger";
import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
  type LatencyRingBuffer,
} from "../../../../shared/utils/latency_ring_buffer";
import { percentile } from "../../../../shared/utils/percentile";
import { getRestPendingRequestCount } from "../registries/rest_pending_requests";
import { getRestAgentDispatchQueueMetricsSnapshot } from "./rest_agent_dispatch_queue";
import { getRelayAgentDispatchQueueMetricsSnapshot } from "./relay_agent_dispatch_queue";
import {
  getRelayOutboundQueueFastMetricsSnapshot,
  getRelayOutboundQueueMetricsSnapshot,
} from "./relay_outbound_queue";
import { getRelayRegisteredRouteCount } from "../registries/relay_request_registry";
import { relayStreamFlowState } from "./relay_stream_flow_state";

const relayCircuitFailureThreshold = env.socketRelayCircuitFailureThreshold;
const relayCircuitOpenMs = env.socketRelayCircuitOpenMs;
const latencySamplesPerAgent = 256;

interface AgentLatencyStats {
  count: number;
  totalMs: number;
  maxMs: number;
  ring: LatencyRingBuffer;
  lastTouchedAtMs: number;
}

type RelayCircuitState = {
  failures: number;
  openUntilMs: number;
  lastTouchedAtMs: number;
};

export type BridgeAckRetryPath = "rest" | "relay";

/** Circuit isolation: REST bridge failures must not open the relay circuit (and vice versa). */
export type AgentCircuitChannel = "rest" | "relay";

const circuitStateKey = (agentId: string, channel: AgentCircuitChannel): string =>
  `${channel}:${agentId}`;

const relayCircuitByAgentId = new Map<string, RelayCircuitState>();
const latencyByAgentId = new Map<string, AgentLatencyStats>();
let latencyByAgentCache: RelayHubMetricsSnapshot["latencyByAgent"] = [];
let latencyByAgentCacheDirty = true;
const maxTrackedAgentStates = 2_048;
const staleCircuitRetentionMs = Math.max(relayCircuitOpenMs * 4, 5 * 60 * 1_000);
const staleLatencyRetentionMs = 30 * 60 * 1_000;

/** Mutable counters for relay + REST bridge paths (also wired from `rest_agent_dispatch_queue`). */
export const relayMetrics = {
  requestsAccepted: 0,
  requestsDeduplicated: 0,
  responsesForwarded: 0,
  chunksForwarded: 0,
  chunksBuffered: 0,
  chunksDropped: 0,
  streamTerminalCompletions: 0,
  streamIdleTimeouts: 0,
  streamLifetimeTimeouts: 0,
  streamDispatchSlotsReleasedOnOpen: 0,
  streamPulls: 0,
  restSqlStreamMaterializePulls: 0,
  /** REST materialization finished successfully (HTTP resolved after merge). */
  restSqlStreamMaterializeCompleted: 0,
  /** Sum of merged row counts for successful REST materializations (for throughput dashboards). */
  restSqlStreamMaterializeRowsMerged: 0,
  restMaterializeRowLimitExceeded: 0,
  restMaterializeChunkLimitExceeded: 0,
  restMaterializeByteLimitExceeded: 0,
  restMaterializeActiveStreamLimitExceeded: 0,
  requestTimeouts: 0,
  ackRetryAttempts: 0,
  ackRetryAttemptsByPath: { rest: 0, relay: 0 } as Record<BridgeAckRetryPath, number>,
  ackRetryExhausted: 0,
  ackRetryExhaustedByPath: { rest: 0, relay: 0 } as Record<BridgeAckRetryPath, number>,
  circuitOpenRejects: 0,
  /** `SOCKET_REST_MAX_PENDING_REQUESTS` cap before dispatch. */
  restGlobalPendingCapRejected: 0,
  /** Agent dispatch queue full or queue wait timeout (`rest_agent_dispatch_queue`). */
  restAgentQueueFullRejected: 0,
  restAgentQueueWaitTimeoutRejected: 0,
  /** Consumer socket not found when attempting to emit relay frame. */
  relayEmitDiscardedConsumerGone: 0,
  /** Relay emit skipped because the consumer transport buffer is saturated. */
  relayEmitBackpressurePaused: 0,
  /** Conversations removed by idle timeout sweep. */
  conversationsExpiredTotal: 0,
  /** relay gate checks in `/consumers` handlers. */
  overloadChecksTotal: 0,
  overloadCheckSumMs: 0,
  frameDecodeSumMs: 0,
  frameDecodeCount: 0,
  commandValidateSumMs: 0,
  commandValidateCount: 0,
  bridgeEncodeSumMs: 0,
  bridgeEncodeCount: 0,
  chunkForwardJobCount: 0,
  chunkForwardJobSumMs: 0,
  bufferDrainRunCount: 0,
  bufferDrainSumMs: 0,
};

let rpcFrameDecodeFailureCount = 0;
let relayMetricsTimer: NodeJS.Timeout | null = null;

export const noteBridgeAckRetryAttempt = (path: BridgeAckRetryPath): void => {
  relayMetrics.ackRetryAttempts += 1;
  relayMetrics.ackRetryAttemptsByPath[path] += 1;
};

export const noteBridgeAckRetryExhausted = (path: BridgeAckRetryPath): void => {
  relayMetrics.ackRetryExhausted += 1;
  relayMetrics.ackRetryExhaustedByPath[path] += 1;
};

export const logRpcFrameDecodeFailure = (input: {
  readonly eventName: string;
  readonly socketId: string;
  readonly reason: string;
}): void => {
  rpcFrameDecodeFailureCount += 1;

  if (rpcFrameDecodeFailureCount <= 5 || rpcFrameDecodeFailureCount % 100 === 0) {
    logger.warn("rpc_frame_decode_failed", {
      event: input.eventName,
      socketId: input.socketId,
      reason: input.reason,
      count: rpcFrameDecodeFailureCount,
    });
  }
};

const pruneRelayCircuitState = (nowMs: number): void => {
  for (const [agentId, state] of relayCircuitByAgentId) {
    if (state.openUntilMs > nowMs) {
      continue;
    }
    if (nowMs - state.lastTouchedAtMs < staleCircuitRetentionMs) {
      continue;
    }
    relayCircuitByAgentId.delete(agentId);
  }

  if (relayCircuitByAgentId.size <= maxTrackedAgentStates) {
    return;
  }

  const removable = Array.from(relayCircuitByAgentId.entries())
    .filter(([, state]) => state.openUntilMs <= nowMs)
    .sort((a, b) => a[1].lastTouchedAtMs - b[1].lastTouchedAtMs);
  for (const [agentId] of removable) {
    relayCircuitByAgentId.delete(agentId);
    if (relayCircuitByAgentId.size <= maxTrackedAgentStates) {
      break;
    }
  }
};

const pruneLatencyState = (nowMs: number): void => {
  for (const [agentId, stats] of latencyByAgentId) {
    if (nowMs - stats.lastTouchedAtMs < staleLatencyRetentionMs) {
      continue;
    }
    latencyByAgentId.delete(agentId);
    latencyByAgentCacheDirty = true;
  }

  if (latencyByAgentId.size <= maxTrackedAgentStates) {
    return;
  }

  const removable = Array.from(latencyByAgentId.entries()).sort(
    (a, b) => a[1].lastTouchedAtMs - b[1].lastTouchedAtMs,
  );
  for (const [agentId] of removable) {
    latencyByAgentId.delete(agentId);
    latencyByAgentCacheDirty = true;
    if (latencyByAgentId.size <= maxTrackedAgentStates) {
      break;
    }
  }
};

const pruneAgentHealthMaps = (nowMs = Date.now()): void => {
  pruneRelayCircuitState(nowMs);
  pruneLatencyState(nowMs);
};

const getCircuitState = (stateKey: string): RelayCircuitState => {
  const nowMs = Date.now();
  pruneRelayCircuitState(nowMs);
  const existing = relayCircuitByAgentId.get(stateKey);
  if (existing) {
    existing.lastTouchedAtMs = nowMs;
    return existing;
  }

  const created = { failures: 0, openUntilMs: 0, lastTouchedAtMs: nowMs };
  relayCircuitByAgentId.set(stateKey, created);
  return created;
};

export const ensureAgentCircuitClosed = (
  agentId: string,
  channel: AgentCircuitChannel,
): void => {
  const state = getCircuitState(circuitStateKey(agentId, channel));
  const nowMs = Date.now();
  if (state.openUntilMs > nowMs) {
    relayMetrics.circuitOpenRejects += 1;
    const retryAfterMs = Math.max(0, state.openUntilMs - nowMs);
    throw serviceUnavailableWithRetry("Agent circuit is open", retryAfterMs);
  }
};

export const registerAgentFailure = (agentId: string, channel: AgentCircuitChannel): void => {
  const key = circuitStateKey(agentId, channel);
  const state = getCircuitState(key);
  state.failures += 1;
  state.lastTouchedAtMs = Date.now();
  if (state.failures >= relayCircuitFailureThreshold) {
    state.openUntilMs = Date.now() + relayCircuitOpenMs;
    state.failures = 0;
  }
  relayCircuitByAgentId.set(key, state);
};

export const registerAgentSuccess = (agentId: string, channel: AgentCircuitChannel): void => {
  const key = circuitStateKey(agentId, channel);
  const state = getCircuitState(key);
  if (state.failures !== 0 || state.openUntilMs !== 0) {
    state.failures = 0;
    state.openUntilMs = 0;
  }
  state.lastTouchedAtMs = Date.now();
  relayCircuitByAgentId.set(key, state);
};

export const observeAgentLatency = (agentId: string, elapsedMs: number): void => {
  const nowMs = Date.now();
  pruneLatencyState(nowMs);
  const safeElapsedMs = Math.max(0, elapsedMs);
  const existing = latencyByAgentId.get(agentId);
  if (existing) {
    existing.count += 1;
    existing.totalMs += safeElapsedMs;
    existing.maxMs = Math.max(existing.maxMs, safeElapsedMs);
    existing.lastTouchedAtMs = nowMs;
    pushLatencyRingBuffer(existing.ring, safeElapsedMs);
    latencyByAgentId.set(agentId, existing);
    latencyByAgentCacheDirty = true;
    return;
  }

  const ring = createLatencyRingBuffer(latencySamplesPerAgent);
  pushLatencyRingBuffer(ring, safeElapsedMs);
  latencyByAgentId.set(agentId, {
    count: 1,
    totalMs: safeElapsedMs,
    maxMs: safeElapsedMs,
    ring,
    lastTouchedAtMs: nowMs,
  });
  latencyByAgentCacheDirty = true;
};

export const observeRelayOverloadCheck = (elapsedMs: number): void => {
  relayMetrics.overloadChecksTotal += 1;
  relayMetrics.overloadCheckSumMs += Math.max(0, elapsedMs);
};

export const observeRelayFrameDecode = (elapsedMs: number): void => {
  relayMetrics.frameDecodeCount += 1;
  relayMetrics.frameDecodeSumMs += Math.max(0, elapsedMs);
};

export const observeRelayCommandValidation = (elapsedMs: number): void => {
  relayMetrics.commandValidateCount += 1;
  relayMetrics.commandValidateSumMs += Math.max(0, elapsedMs);
};

export const observeRelayBridgeEncode = (elapsedMs: number): void => {
  relayMetrics.bridgeEncodeCount += 1;
  relayMetrics.bridgeEncodeSumMs += Math.max(0, elapsedMs);
};

export const observeRelayChunkForwardJob = (elapsedMs: number): void => {
  relayMetrics.chunkForwardJobCount += 1;
  relayMetrics.chunkForwardJobSumMs += Math.max(0, elapsedMs);
};

export const observeRelayBufferDrain = (elapsedMs: number): void => {
  relayMetrics.bufferDrainRunCount += 1;
  relayMetrics.bufferDrainSumMs += Math.max(0, elapsedMs);
};

export type RelayHubMetricsSnapshot = {
  readonly counters: {
    readonly requestsAccepted: number;
    readonly requestsDeduplicated: number;
    readonly responsesForwarded: number;
    readonly chunksForwarded: number;
    readonly chunksBuffered: number;
    readonly chunksDropped: number;
    readonly streamTerminalCompletions: number;
    readonly streamIdleTimeouts: number;
    readonly streamLifetimeTimeouts: number;
    readonly streamDispatchSlotsReleasedOnOpen: number;
    readonly streamPulls: number;
    readonly restSqlStreamMaterializePulls: number;
    readonly restSqlStreamMaterializeCompleted: number;
    readonly restSqlStreamMaterializeRowsMerged: number;
    readonly restMaterializeRowLimitExceeded: number;
    readonly restMaterializeChunkLimitExceeded: number;
    readonly restMaterializeByteLimitExceeded: number;
    readonly restMaterializeActiveStreamLimitExceeded: number;
    readonly requestTimeouts: number;
    readonly ackRetryAttempts: number;
    readonly ackRetryAttemptsByPath: Record<BridgeAckRetryPath, number>;
    readonly ackRetryExhausted: number;
    readonly ackRetryExhaustedByPath: Record<BridgeAckRetryPath, number>;
    readonly circuitOpenRejects: number;
    readonly restGlobalPendingCapRejected: number;
    readonly restAgentQueueFullRejected: number;
    readonly restAgentQueueWaitTimeoutRejected: number;
    readonly rpcFrameDecodeFailed: number;
    readonly relayEmitDiscardedConsumerGone: number;
    readonly relayEmitBackpressurePaused: number;
    readonly conversationsExpiredTotal: number;
    readonly overloadChecksTotal: number;
    readonly overloadCheckSumMs: number;
    readonly frameDecodeCount: number;
    readonly frameDecodeSumMs: number;
    readonly commandValidateCount: number;
    readonly commandValidateSumMs: number;
    readonly bridgeEncodeCount: number;
    readonly bridgeEncodeSumMs: number;
    readonly chunkForwardJobCount: number;
    readonly chunkForwardJobSumMs: number;
    readonly bufferDrainRunCount: number;
    readonly bufferDrainSumMs: number;
  };
  readonly gauges: {
    readonly pendingRelayRequests: number;
    readonly pendingRestRequests: number;
    readonly activeStreams: number;
    readonly restMaterializeStreamsInFlight: number;
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
  readonly relayOutboundQueue: ReturnType<typeof getRelayOutboundQueueMetricsSnapshot>;
  readonly restAgentDispatchQueue: ReturnType<typeof getRestAgentDispatchQueueMetricsSnapshot>;
  readonly relayAgentDispatchQueue: ReturnType<typeof getRelayAgentDispatchQueueMetricsSnapshot>;
};

export const buildRelayHubMetricsSnapshot = (input: {
  readonly activeStreams: number;
  readonly restMaterializeStreamsInFlight: number;
  readonly useFastQueueSnapshot?: boolean;
}): RelayHubMetricsSnapshot => {
  const nowMs = Date.now();
  pruneAgentHealthMaps(nowMs);
  const openCircuits = Array.from(relayCircuitByAgentId.values()).filter(
    (state) => state.openUntilMs > nowMs,
  ).length;

  if (latencyByAgentCacheDirty) {
    latencyByAgentCache = Array.from(latencyByAgentId.entries()).map(([agentId, stats]) => {
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
    latencyByAgentCacheDirty = false;
  }

  return {
    counters: {
      ...relayMetrics,
      rpcFrameDecodeFailed: rpcFrameDecodeFailureCount,
    },
    gauges: {
      pendingRelayRequests: getRelayRegisteredRouteCount(),
      pendingRestRequests: getRestPendingRequestCount(),
      activeStreams: input.activeStreams,
      restMaterializeStreamsInFlight: input.restMaterializeStreamsInFlight,
      bufferedChunks: relayStreamFlowState.totalBufferedChunks,
      openCircuits,
    },
    latencyByAgent: latencyByAgentCache,
    relayOutboundQueue:
      input.useFastQueueSnapshot === true
        ? getRelayOutboundQueueFastMetricsSnapshot()
        : getRelayOutboundQueueMetricsSnapshot(),
    restAgentDispatchQueue: getRestAgentDispatchQueueMetricsSnapshot(),
    relayAgentDispatchQueue: getRelayAgentDispatchQueueMetricsSnapshot(),
  };
};

export const scheduleRelayHubMetricsLogger = (getSnapshot: () => RelayHubMetricsSnapshot): void => {
  if (relayMetricsTimer) {
    return;
  }

  relayMetricsTimer = setInterval(() => {
    const snapshot = getSnapshot();
    logger.info("socket_relay_metrics", {
      ...snapshot.counters,
      ...snapshot.gauges,
      relayOutboundQueue: snapshot.relayOutboundQueue,
      restAgentDispatchQueue: snapshot.restAgentDispatchQueue,
      relayAgentDispatchQueue: snapshot.relayAgentDispatchQueue,
    });
  }, env.socketRelayMetricsLogIntervalMs);
  relayMetricsTimer.unref?.();
};

export const stopRelayHubMetricsLogger = (): void => {
  if (!relayMetricsTimer) {
    return;
  }
  clearInterval(relayMetricsTimer);
  relayMetricsTimer = null;
};

export const resetRelayHubHealthAndMetrics = (): void => {
  relayCircuitByAgentId.clear();
  latencyByAgentId.clear();
  latencyByAgentCache = [];
  latencyByAgentCacheDirty = true;

  relayMetrics.requestsAccepted = 0;
  relayMetrics.requestsDeduplicated = 0;
  relayMetrics.responsesForwarded = 0;
  relayMetrics.chunksForwarded = 0;
  relayMetrics.chunksBuffered = 0;
  relayMetrics.chunksDropped = 0;
  relayMetrics.streamTerminalCompletions = 0;
  relayMetrics.streamIdleTimeouts = 0;
  relayMetrics.streamLifetimeTimeouts = 0;
  relayMetrics.streamDispatchSlotsReleasedOnOpen = 0;
  relayMetrics.streamPulls = 0;
  relayMetrics.restSqlStreamMaterializePulls = 0;
  relayMetrics.restSqlStreamMaterializeCompleted = 0;
  relayMetrics.restSqlStreamMaterializeRowsMerged = 0;
  relayMetrics.restMaterializeRowLimitExceeded = 0;
  relayMetrics.restMaterializeChunkLimitExceeded = 0;
  relayMetrics.restMaterializeByteLimitExceeded = 0;
  relayMetrics.restMaterializeActiveStreamLimitExceeded = 0;
  relayMetrics.requestTimeouts = 0;
  relayMetrics.ackRetryAttempts = 0;
  relayMetrics.ackRetryAttemptsByPath.rest = 0;
  relayMetrics.ackRetryAttemptsByPath.relay = 0;
  relayMetrics.ackRetryExhausted = 0;
  relayMetrics.ackRetryExhaustedByPath.rest = 0;
  relayMetrics.ackRetryExhaustedByPath.relay = 0;
  relayMetrics.circuitOpenRejects = 0;
  relayMetrics.restGlobalPendingCapRejected = 0;
  relayMetrics.restAgentQueueFullRejected = 0;
  relayMetrics.restAgentQueueWaitTimeoutRejected = 0;
  relayMetrics.relayEmitDiscardedConsumerGone = 0;
  relayMetrics.relayEmitBackpressurePaused = 0;
  relayMetrics.conversationsExpiredTotal = 0;
  relayMetrics.overloadChecksTotal = 0;
  relayMetrics.overloadCheckSumMs = 0;
  relayMetrics.frameDecodeCount = 0;
  relayMetrics.frameDecodeSumMs = 0;
  relayMetrics.commandValidateCount = 0;
  relayMetrics.commandValidateSumMs = 0;
  relayMetrics.bridgeEncodeCount = 0;
  relayMetrics.bridgeEncodeSumMs = 0;
  relayMetrics.chunkForwardJobCount = 0;
  relayMetrics.chunkForwardJobSumMs = 0;
  relayMetrics.bufferDrainRunCount = 0;
  relayMetrics.bufferDrainSumMs = 0;
  rpcFrameDecodeFailureCount = 0;
};
