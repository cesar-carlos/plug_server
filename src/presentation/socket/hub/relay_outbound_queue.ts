/**
 * Serializes hub → consumer relay emits per JSON-RPC `requestId` so async gzip
 * (`encodePayloadFrameBridge`) cannot reorder `relay:rpc.response` / `relay:rpc.chunk` / `relay:rpc.complete`.
 */

import { env } from "../../../shared/config/env";
import { encodePayloadFrameBridge, type PayloadFrameEnvelope } from "../../../shared/utils/payload_frame";
import { logger } from "../../../shared/utils/logger";
import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
} from "../../../shared/utils/latency_ring_buffer";
import { percentile } from "../../../shared/utils/percentile";

type TailEntry = {
  tail: Promise<void>;
  pendingJobs: number;
  lastActivityAtMs: number;
};

const tailByRequestId = new Map<string, TailEntry>();
const durationSamplesSize = 256;

const metrics = {
  jobsEnqueuedTotal: 0,
  jobsFinishedTotal: 0,
  jobsFailedTotal: 0,
  jobsSweptOrphanedTotal: 0,
  overloadRejectedTotal: 0,
  orphanedTailsSweptTotal: 0,
  jobDurationSumMs: 0,
  jobDurationMaxMs: 0,
  durationRing: createLatencyRingBuffer(durationSamplesSize),
};

export type RelayOutboundQueueMetricsSnapshot = {
  readonly jobsEnqueuedTotal: number;
  readonly jobsFinishedTotal: number;
  readonly jobsFailedTotal: number;
  readonly overloadRejectedTotal: number;
  readonly orphanedTailsSweptTotal: number;
  readonly jobDurationSumMs: number;
  readonly jobDurationAvgMs: number;
  readonly jobDurationMaxMs: number;
  readonly jobDurationP95Ms: number;
  readonly jobDurationP99Ms: number;
  readonly inflightRequestIds: number;
  readonly orphanedRequestIds: number;
  readonly backlog: number;
};

const deriveBacklog = (): number =>
  Math.max(0, metrics.jobsEnqueuedTotal - metrics.jobsFinishedTotal - metrics.jobsSweptOrphanedTotal);

const isTailEntryOrphaned = (entry: TailEntry, nowMs: number): boolean =>
  entry.pendingJobs > 0 && nowMs - entry.lastActivityAtMs >= env.socketRelayOutboundTailStaleMs;

const countOrphanedRequestIds = (nowMs: number): number => {
  let total = 0;
  for (const entry of tailByRequestId.values()) {
    if (isTailEntryOrphaned(entry, nowMs)) {
      total += 1;
    }
  }
  return total;
};

export const getRelayOutboundQueueMetricsSnapshot = (): RelayOutboundQueueMetricsSnapshot => {
  const finished = metrics.jobsFinishedTotal;
  const sampleSlice = latencyRingBufferValues(metrics.durationRing);
  const nowMs = Date.now();
  const backlog = deriveBacklog();
  return {
    jobsEnqueuedTotal: metrics.jobsEnqueuedTotal,
    jobsFinishedTotal: finished,
    jobsFailedTotal: metrics.jobsFailedTotal,
    overloadRejectedTotal: metrics.overloadRejectedTotal,
    orphanedTailsSweptTotal: metrics.orphanedTailsSweptTotal,
    jobDurationSumMs: metrics.jobDurationSumMs,
    jobDurationAvgMs: finished > 0 ? Number((metrics.jobDurationSumMs / finished).toFixed(4)) : 0,
    jobDurationMaxMs: metrics.jobDurationMaxMs,
    jobDurationP95Ms: Number(percentile(sampleSlice, 95).toFixed(2)),
    jobDurationP99Ms: Number(percentile(sampleSlice, 99).toFixed(2)),
    inflightRequestIds: tailByRequestId.size,
    orphanedRequestIds: countOrphanedRequestIds(nowMs),
    backlog,
  };
};

export const sweepRelayOutboundQueueState = (nowMs = Date.now()): number => {
  let swept = 0;
  for (const [requestId, entry] of tailByRequestId.entries()) {
    if (!isTailEntryOrphaned(entry, nowMs)) {
      continue;
    }
    tailByRequestId.delete(requestId);
    swept += 1;
    metrics.jobsSweptOrphanedTotal += entry.pendingJobs;
  }
  metrics.orphanedTailsSweptTotal += swept;
  return swept;
};

export const getRelayOutboundQueueOverloadState = (): {
  readonly overloaded: boolean;
  readonly reason: "backlog" | "p95_latency" | null;
  readonly retryAfterMs: number;
  readonly snapshot: RelayOutboundQueueMetricsSnapshot;
} => {
  const snapshot = getRelayOutboundQueueMetricsSnapshot();
  const backlogThreshold = env.socketRelayOutboundOverloadBacklog;
  if (backlogThreshold > 0 && snapshot.backlog >= backlogThreshold) {
    return {
      overloaded: true,
      reason: "backlog",
      retryAfterMs: Math.max(250, Math.min(env.socketRelayOutboundSweepIntervalMs, 1_000)),
      snapshot,
    };
  }

  const p95Threshold = env.socketRelayOutboundOverloadP95Ms;
  if (p95Threshold > 0 && snapshot.jobDurationP95Ms >= p95Threshold) {
    return {
      overloaded: true,
      reason: "p95_latency",
      retryAfterMs: Math.max(250, Math.min(env.socketRelayOutboundSweepIntervalMs, 1_000)),
      snapshot,
    };
  }

  return {
    overloaded: false,
    reason: null,
    retryAfterMs: 0,
    snapshot,
  };
};

export const noteRelayOutboundQueueOverloadRejected = (): void => {
  metrics.overloadRejectedTotal += 1;
};

const resetRelayOutboundQueueMetrics = (): void => {
  metrics.jobsEnqueuedTotal = 0;
  metrics.jobsFinishedTotal = 0;
  metrics.jobsFailedTotal = 0;
  metrics.jobsSweptOrphanedTotal = 0;
  metrics.overloadRejectedTotal = 0;
  metrics.orphanedTailsSweptTotal = 0;
  metrics.jobDurationSumMs = 0;
  metrics.jobDurationMaxMs = 0;
  metrics.durationRing = createLatencyRingBuffer(durationSamplesSize);
};

/**
 * Clears pending tails and metric counters (bridge/tests reset).
 */
export const resetRelayOutboundQueueState = (): void => {
  tailByRequestId.clear();
  resetRelayOutboundQueueMetrics();
};

/** @deprecated Use `resetRelayOutboundQueueState` */
export const resetRelayOutboundQueueTails = (): void => {
  resetRelayOutboundQueueState();
};

export const enqueueRelayOutbound = (requestId: string, work: () => void | Promise<void>): void => {
  metrics.jobsEnqueuedTotal += 1;
  const entry = tailByRequestId.get(requestId) ?? {
    tail: Promise.resolve(),
    pendingJobs: 0,
    lastActivityAtMs: Date.now(),
  };
  entry.pendingJobs += 1;
  entry.lastActivityAtMs = Date.now();
  const prev = entry.tail;
  const next = prev.then(async () => {
    const t0 = performance.now();
    try {
      await work();
    } catch (err: unknown) {
      metrics.jobsFailedTotal += 1;
      logger.error("relay_outbound_queue_job_failed", {
        requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const ms = performance.now() - t0;
      metrics.jobsFinishedTotal += 1;
      metrics.jobDurationSumMs += ms;
      metrics.jobDurationMaxMs = Math.max(metrics.jobDurationMaxMs, ms);
      pushLatencyRingBuffer(metrics.durationRing, ms);
    }
  });
  entry.tail = next;
  tailByRequestId.set(requestId, entry);
  void next.finally(() => {
    const current = tailByRequestId.get(requestId);
    if (!current) {
      return;
    }
    current.pendingJobs = Math.max(0, current.pendingJobs - 1);
    current.lastActivityAtMs = Date.now();
    if (current.tail === next && current.pendingJobs === 0) {
      tailByRequestId.delete(requestId);
      return;
    }
    tailByRequestId.set(requestId, current);
  });
};

export const encodeRelayOutboundFrame = async (
  data: unknown,
  requestId: string,
): Promise<PayloadFrameEnvelope> =>
  encodePayloadFrameBridge(data, { requestId, omitTraceId: true });
