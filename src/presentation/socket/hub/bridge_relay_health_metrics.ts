import { env } from "../../../shared/config/env";
import { serviceUnavailable } from "../../../shared/errors/http_errors";
import { logger } from "../../../shared/utils/logger";
import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
  type LatencyRingBuffer,
} from "../../../shared/utils/latency_ring_buffer";
import { percentile } from "../../../shared/utils/percentile";
import { getRestPendingRequestCount } from "./rest_pending_requests";
import { getRelayRegisteredRouteCount } from "./relay_request_registry";
import { relayStreamFlowState } from "./relay_stream_flow_state";

const relayCircuitFailureThreshold = env.socketRelayCircuitFailureThreshold;
const relayCircuitOpenMs = env.socketRelayCircuitOpenMs;
const latencySamplesPerAgent = 256;

interface AgentLatencyStats {
  count: number;
  totalMs: number;
  maxMs: number;
  ring: LatencyRingBuffer;
}

const relayCircuitByAgentId = new Map<string, { failures: number; openUntilMs: number }>();
const latencyByAgentId = new Map<string, AgentLatencyStats>();

/** Mutable counters for relay + REST bridge paths (also wired from `rest_agent_dispatch_queue`). */
export const relayMetrics = {
  requestsAccepted: 0,
  requestsDeduplicated: 0,
  responsesForwarded: 0,
  chunksForwarded: 0,
  chunksBuffered: 0,
  chunksDropped: 0,
  streamPulls: 0,
  restSqlStreamMaterializePulls: 0,
  requestTimeouts: 0,
  circuitOpenRejects: 0,
  restPendingRejected: 0,
};

let rpcFrameDecodeFailureCount = 0;
let relayMetricsTimer: NodeJS.Timeout | null = null;

const withAppendedMessage = (base: string, extra: string): string =>
  extra.trim() === "" ? base : `${base}. ${extra}`;

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

const getCircuitState = (agentId: string): { failures: number; openUntilMs: number } => {
  const existing = relayCircuitByAgentId.get(agentId);
  if (existing) {
    return existing;
  }

  const created = { failures: 0, openUntilMs: 0 };
  relayCircuitByAgentId.set(agentId, created);
  return created;
};

export const ensureAgentCircuitClosed = (agentId: string): void => {
  const state = getCircuitState(agentId);
  if (state.openUntilMs > Date.now()) {
    relayMetrics.circuitOpenRejects += 1;
    const retryAfterMs = Math.max(0, state.openUntilMs - Date.now());
    throw serviceUnavailable(
      withAppendedMessage("Agent circuit is open", `retry_after_ms=${retryAfterMs}`),
    );
  }
};

export const registerAgentFailure = (agentId: string): void => {
  const state = getCircuitState(agentId);
  state.failures += 1;
  if (state.failures >= relayCircuitFailureThreshold) {
    state.openUntilMs = Date.now() + relayCircuitOpenMs;
    state.failures = 0;
  }
  relayCircuitByAgentId.set(agentId, state);
};

export const registerAgentSuccess = (agentId: string): void => {
  const state = getCircuitState(agentId);
  if (state.failures !== 0 || state.openUntilMs !== 0) {
    state.failures = 0;
    state.openUntilMs = 0;
    relayCircuitByAgentId.set(agentId, state);
  }
};

export const observeAgentLatency = (agentId: string, elapsedMs: number): void => {
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

export type RelayHubMetricsSnapshot = {
  readonly counters: {
    readonly requestsAccepted: number;
    readonly requestsDeduplicated: number;
    readonly responsesForwarded: number;
    readonly chunksForwarded: number;
    readonly chunksBuffered: number;
    readonly chunksDropped: number;
    readonly streamPulls: number;
    readonly restSqlStreamMaterializePulls: number;
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
};

export const buildRelayHubMetricsSnapshot = (input: {
  readonly activeStreams: number;
}): RelayHubMetricsSnapshot => {
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
      pendingRelayRequests: getRelayRegisteredRouteCount(),
      pendingRestRequests: getRestPendingRequestCount(),
      activeStreams: input.activeStreams,
      bufferedChunks: relayStreamFlowState.totalBufferedChunks,
      openCircuits,
    },
    latencyByAgent,
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

  relayMetrics.requestsAccepted = 0;
  relayMetrics.requestsDeduplicated = 0;
  relayMetrics.responsesForwarded = 0;
  relayMetrics.chunksForwarded = 0;
  relayMetrics.chunksBuffered = 0;
  relayMetrics.chunksDropped = 0;
  relayMetrics.streamPulls = 0;
  relayMetrics.restSqlStreamMaterializePulls = 0;
  relayMetrics.requestTimeouts = 0;
  relayMetrics.circuitOpenRejects = 0;
  relayMetrics.restPendingRejected = 0;
  rpcFrameDecodeFailureCount = 0;
};
