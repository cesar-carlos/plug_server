/**
 * Serializes hub → consumer relay emits per JSON-RPC `requestId` so async gzip
 * (`encodePayloadFrameBridge`) cannot reorder `relay:rpc.response` / `relay:rpc.chunk` / `relay:rpc.complete`.
 */

import { env } from "../../../../shared/config/env";
import {
  encodePayloadFrameBridge,
  encodePayloadFrameFromBytes,
  encodePayloadFrameFromBytesAsync,
  encodePayloadFrameFromPreencodedWire,
  type PayloadFrameEnvelope,
} from "../../../../shared/utils/payload_frame";
import { logger } from "../../../../shared/utils/logger";
import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
} from "../../../../shared/utils/latency_ring_buffer";
import { percentile } from "../../../../shared/utils/percentile";

type TailEntry = {
  tail: Promise<void>;
  pendingJobs: number;
  activeJobs: number;
  lastActivityAtMs: number;
};

const tailByRequestId = new Map<string, TailEntry>();
const durationSamplesSize = 256;
const relayOutboundForceGzipSymbol = Symbol("relayOutboundForceGzip");

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
  overloadStateRefreshTotal: 0,
};

type OverloadStateCache = {
  readonly overloaded: boolean;
  readonly reason: "backlog" | "p95_latency" | null;
  readonly retryAfterMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly backlog: number;
  readonly computedAtMs: number;
};

let cachedOrphanedRequestIds = 0;
let overloadStateCache: OverloadStateCache = {
  overloaded: false,
  reason: null,
  retryAfterMs: 0,
  p95Ms: 0,
  p99Ms: 0,
  backlog: 0,
  computedAtMs: 0,
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
  readonly overloadStateRefreshTotal: number;
  readonly overloadCacheP95Ms: number;
  readonly overloadCacheComputedAtMs: number;
};

const deriveBacklog = (): number =>
  Math.max(
    0,
    metrics.jobsEnqueuedTotal - metrics.jobsFinishedTotal - metrics.jobsSweptOrphanedTotal,
  );

const isTailEntryOrphaned = (entry: TailEntry, nowMs: number): boolean =>
  entry.pendingJobs === 0 &&
  entry.activeJobs === 0 &&
  nowMs - entry.lastActivityAtMs >= env.socketRelayOutboundTailStaleMs;

const countOrphanedRequestIds = (nowMs: number): number => {
  let total = 0;
  for (const entry of tailByRequestId.values()) {
    if (isTailEntryOrphaned(entry, nowMs)) {
      total += 1;
    }
  }
  return total;
};

const retryAfterFromSweep = (): number =>
  Math.max(250, Math.min(env.socketRelayOutboundSweepIntervalMs, 1_000));

const resolveBacklogThresholds = (): { readonly enter: number; readonly exit: number } => {
  const enter = env.socketRelayOutboundOverloadBacklog;
  const configuredExit = env.socketRelayOutboundOverloadBacklogExit;
  return {
    enter,
    exit: configuredExit > 0 ? configuredExit : enter,
  };
};

const resolveP95Thresholds = (): { readonly enter: number; readonly exit: number } => {
  const enter = env.socketRelayOutboundOverloadP95Ms;
  const configuredExit = env.socketRelayOutboundOverloadP95ExitMs;
  return {
    enter,
    exit: configuredExit > 0 ? configuredExit : enter,
  };
};

const computeOverloadSignals = (
  backlog: number,
  p95Ms: number,
  wasOverloaded: boolean,
): { readonly overloadedByBacklog: boolean; readonly overloadedByP95: boolean } => {
  const backlogThresholds = resolveBacklogThresholds();
  const p95Thresholds = resolveP95Thresholds();

  const overloadedByBacklog =
    backlogThresholds.enter > 0 &&
    (wasOverloaded ? backlog >= backlogThresholds.exit : backlog >= backlogThresholds.enter);
  const overloadedByP95 =
    p95Thresholds.enter > 0 &&
    (wasOverloaded ? p95Ms >= p95Thresholds.exit : p95Ms >= p95Thresholds.enter);

  return { overloadedByBacklog, overloadedByP95 };
};

const updateOverloadStateCache = (input: {
  p95Ms?: number;
  p99Ms?: number;
  nowMs?: number;
}): void => {
  const nowMs = input.nowMs ?? Date.now();
  const backlog = deriveBacklog();
  const p95Ms = input.p95Ms ?? overloadStateCache.p95Ms;
  const p99Ms = input.p99Ms ?? overloadStateCache.p99Ms;
  const wasOverloaded = overloadStateCache.overloaded;
  const { overloadedByBacklog, overloadedByP95 } = computeOverloadSignals(
    backlog,
    p95Ms,
    wasOverloaded,
  );
  overloadStateCache = {
    overloaded: overloadedByBacklog || overloadedByP95,
    reason: overloadedByBacklog ? "backlog" : overloadedByP95 ? "p95_latency" : null,
    retryAfterMs: overloadedByBacklog || overloadedByP95 ? retryAfterFromSweep() : 0,
    p95Ms,
    p99Ms,
    backlog,
    computedAtMs: nowMs,
  };
};

const updateBacklogOnlyOverloadStateCache = (nowMs = Date.now()): void => {
  const backlog = deriveBacklog();
  const wasOverloaded = overloadStateCache.overloaded;
  const { overloadedByBacklog, overloadedByP95 } = computeOverloadSignals(
    backlog,
    overloadStateCache.p95Ms,
    wasOverloaded,
  );
  overloadStateCache = {
    overloaded: overloadedByBacklog || overloadedByP95,
    reason: overloadedByBacklog ? "backlog" : overloadedByP95 ? "p95_latency" : null,
    retryAfterMs: overloadedByBacklog || overloadedByP95 ? retryAfterFromSweep() : 0,
    p95Ms: overloadStateCache.p95Ms,
    p99Ms: overloadStateCache.p99Ms,
    backlog,
    computedAtMs: nowMs,
  };
};

export const getRelayOutboundQueueMetricsSnapshot = (): RelayOutboundQueueMetricsSnapshot => {
  const finished = metrics.jobsFinishedTotal;
  const sampleSlice = latencyRingBufferValues(metrics.durationRing);
  const p95 = Number(percentile(sampleSlice, 95).toFixed(2));
  const p99 = Number(percentile(sampleSlice, 99).toFixed(2));
  const nowMs = Date.now();
  cachedOrphanedRequestIds = countOrphanedRequestIds(nowMs);
  const backlog = deriveBacklog();
  updateOverloadStateCache({ p95Ms: p95, p99Ms: p99, nowMs });
  metrics.overloadStateRefreshTotal += 1;
  return {
    jobsEnqueuedTotal: metrics.jobsEnqueuedTotal,
    jobsFinishedTotal: finished,
    jobsFailedTotal: metrics.jobsFailedTotal,
    overloadRejectedTotal: metrics.overloadRejectedTotal,
    orphanedTailsSweptTotal: metrics.orphanedTailsSweptTotal,
    jobDurationSumMs: metrics.jobDurationSumMs,
    jobDurationAvgMs: finished > 0 ? Number((metrics.jobDurationSumMs / finished).toFixed(4)) : 0,
    jobDurationMaxMs: metrics.jobDurationMaxMs,
    jobDurationP95Ms: p95,
    jobDurationP99Ms: p99,
    inflightRequestIds: tailByRequestId.size,
    orphanedRequestIds: cachedOrphanedRequestIds,
    backlog,
    overloadStateRefreshTotal: metrics.overloadStateRefreshTotal,
    overloadCacheP95Ms: overloadStateCache.p95Ms,
    overloadCacheComputedAtMs: overloadStateCache.computedAtMs,
  };
};

const getFastMetricsSnapshot = (): RelayOutboundQueueMetricsSnapshot => {
  const finished = metrics.jobsFinishedTotal;
  return {
    jobsEnqueuedTotal: metrics.jobsEnqueuedTotal,
    jobsFinishedTotal: finished,
    jobsFailedTotal: metrics.jobsFailedTotal,
    overloadRejectedTotal: metrics.overloadRejectedTotal,
    orphanedTailsSweptTotal: metrics.orphanedTailsSweptTotal,
    jobDurationSumMs: metrics.jobDurationSumMs,
    jobDurationAvgMs: finished > 0 ? Number((metrics.jobDurationSumMs / finished).toFixed(4)) : 0,
    jobDurationMaxMs: metrics.jobDurationMaxMs,
    jobDurationP95Ms: overloadStateCache.p95Ms,
    jobDurationP99Ms: overloadStateCache.p99Ms,
    inflightRequestIds: tailByRequestId.size,
    orphanedRequestIds: cachedOrphanedRequestIds,
    backlog: overloadStateCache.backlog,
    overloadStateRefreshTotal: metrics.overloadStateRefreshTotal,
    overloadCacheP95Ms: overloadStateCache.p95Ms,
    overloadCacheComputedAtMs: overloadStateCache.computedAtMs,
  };
};

export const getRelayOutboundQueueFastMetricsSnapshot = (): RelayOutboundQueueMetricsSnapshot =>
  getFastMetricsSnapshot();

/**
 * Heavy refresh (percentile + orphan scan), intended for periodic sweep/metrics paths.
 */
export const refreshRelayOutboundQueueOverloadState = (nowMs = Date.now()): void => {
  cachedOrphanedRequestIds = countOrphanedRequestIds(nowMs);
  const sampleSlice = latencyRingBufferValues(metrics.durationRing);
  updateOverloadStateCache({
    p95Ms: Number(percentile(sampleSlice, 95).toFixed(2)),
    p99Ms: Number(percentile(sampleSlice, 99).toFixed(2)),
    nowMs,
  });
  metrics.overloadStateRefreshTotal += 1;
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
  refreshRelayOutboundQueueOverloadState(nowMs);
  return swept;
};

/**
 * Maximum age (ms) of `overloadStateCache.p95Ms` before
 * `getRelayOutboundQueueOverloadState` triggers an on-demand refresh.
 * Bounds shedding lag without re-computing percentiles on every event.
 */
const OVERLOAD_STATE_MAX_STALE_MS = 1_000;

export const getRelayOutboundQueueOverloadState = (): {
  readonly overloaded: boolean;
  readonly reason: "backlog" | "p95_latency" | null;
  readonly retryAfterMs: number;
  readonly snapshot: RelayOutboundQueueMetricsSnapshot;
} => {
  const nowMs = Date.now();
  updateBacklogOnlyOverloadStateCache(nowMs);
  if (overloadStateCache.reason !== "backlog") {
    // Lazy refresh: if the percentile cache is older than the staleness budget,
    // recompute now. This keeps shedding-by-p95 reactive (within 1s) without
    // requiring a percentile recomputation on every relay event.
    if (
      env.socketRelayOutboundOverloadP95Ms > 0 &&
      nowMs - overloadStateCache.computedAtMs >= OVERLOAD_STATE_MAX_STALE_MS
    ) {
      refreshRelayOutboundQueueOverloadState(nowMs);
    }
  }
  const snapshot = getFastMetricsSnapshot();
  return {
    overloaded: overloadStateCache.overloaded,
    reason: overloadStateCache.reason,
    retryAfterMs: overloadStateCache.retryAfterMs,
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
  metrics.overloadStateRefreshTotal = 0;
};

/**
 * Clears pending tails and metric counters (bridge/tests reset).
 */
export const resetRelayOutboundQueueState = (): void => {
  tailByRequestId.clear();
  cachedOrphanedRequestIds = 0;
  overloadStateCache = {
    overloaded: false,
    reason: null,
    retryAfterMs: 0,
    p95Ms: 0,
    p99Ms: 0,
    backlog: 0,
    computedAtMs: 0,
  };
  resetRelayOutboundQueueMetrics();
};

/** @deprecated Use `resetRelayOutboundQueueState` */
export const resetRelayOutboundQueueTails = (): void => {
  resetRelayOutboundQueueState();
};

export const enqueueRelayOutbound = (requestId: string, work: () => void | Promise<void>): void => {
  metrics.jobsEnqueuedTotal += 1;
  const nowMs = Date.now();
  updateBacklogOnlyOverloadStateCache(nowMs);
  const entry = tailByRequestId.get(requestId) ?? {
    tail: Promise.resolve(),
    pendingJobs: 0,
    activeJobs: 0,
    lastActivityAtMs: nowMs,
  };
  entry.pendingJobs += 1;
  entry.lastActivityAtMs = nowMs;
  const prev = entry.tail;
  const next = prev.then(async () => {
    const t0 = performance.now();
    entry.activeJobs += 1;
    entry.lastActivityAtMs = Date.now();
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
      updateBacklogOnlyOverloadStateCache();
      entry.activeJobs = Math.max(0, entry.activeJobs - 1);
      entry.lastActivityAtMs = Date.now();
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

export const markRelayOutboundForceGzip = <T extends Record<string, unknown>>(payload: T): T => {
  Object.defineProperty(payload, relayOutboundForceGzipSymbol, {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return payload;
};

const shouldForceRelayOutboundGzip = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  (data as Record<symbol, unknown>)[relayOutboundForceGzipSymbol] === true;

export const encodeRelayOutboundFrame = async (
  data: unknown,
  requestId: string,
): Promise<PayloadFrameEnvelope> =>
  encodePayloadFrameBridge(data, {
    requestId,
    omitTraceId: true,
    ...(shouldForceRelayOutboundGzip(data)
      ? {
          compressionThreshold: 1,
          compressionPolicy: "always_gzip" as const,
        }
      : {}),
  });

/**
 * Fast-path encoder for relay forward when the agent's payload bytes are
 * forwarded **unchanged**. Skips `JSON.stringify` by reusing the decoded
 * UTF-8 bytes from {@link DecodedPayloadFrame.decodedBytes}. The compression
 * policy follows the inbound `cmp` so that bytes the agent already sent
 * compressed are re-compressed (with hub keys) on the way out.
 *
 * Use only when the JSON-RPC payload is **not mutated** — e.g. no
 * `meta.serverTimings` injection and the response was not transformed by a
 * stream merger. See `rpc_bridge_agent_inbound.ts`.
 */
export const encodeRelayOutboundFrameFromBytes = (
  bytes: Buffer,
  requestId: string,
  options: { readonly inboundCmp: "none" | "gzip" },
): PayloadFrameEnvelope =>
  encodePayloadFrameFromBytes(bytes, {
    requestId,
    omitTraceId: true,
    ...(options.inboundCmp === "gzip"
      ? {
          compressionThreshold: 1,
          compressionPolicy: "always_gzip" as const,
        }
      : {}),
  });

/**
 * Async sibling of {@link encodeRelayOutboundFrameFromBytes}: keeps gzip of
 * large forwarded chunks off the event loop (libuv thread pool) the same way
 * {@link encodeRelayOutboundFrame} does, while still skipping `JSON.stringify`.
 * Used by the relay chunk byte-forward drain.
 */
export const encodeRelayOutboundFrameFromBytesAsync = async (
  bytes: Buffer,
  requestId: string,
  options: { readonly inboundCmp: "none" | "gzip" },
): Promise<PayloadFrameEnvelope> =>
  encodePayloadFrameFromBytesAsync(bytes, {
    requestId,
    omitTraceId: true,
    ...(options.inboundCmp === "gzip"
      ? {
          compressionThreshold: 1,
          compressionPolicy: "always_gzip" as const,
        }
      : {}),
  });

/**
 * Wire passthrough: rebuild envelope from agent compressed (or none) bytes
 * without a second gzip. Prefer this when inbound `cmp`/`originalSize`/`payload`
 * were validated and the JSON-RPC body is not mutated.
 */
export const encodeRelayOutboundFrameFromPreencodedWireAsync = async (
  body: {
    readonly originalSize: number;
    readonly wireBytes: Buffer;
    readonly cmp: "none" | "gzip";
  },
  requestId: string,
): Promise<PayloadFrameEnvelope> =>
  encodePayloadFrameFromPreencodedWire(body, {
    requestId,
    omitTraceId: true,
  });
