/**
 * Optional per-agent Redis Streams state for at-least-once delivery of
 * `client:custom.*` frames across hub replicas. Exposed via GET /metrics.
 */

import {
  createRedisCommandLatencyHistogram,
  type RedisCommandLatencyHistogramSnapshot,
} from "./redis_command_latency_histogram";

export type AgentEventStreamLatencyOp = "append" | "read" | "ack" | "trim";

const latencyHistograms: Record<
  AgentEventStreamLatencyOp,
  ReturnType<typeof createRedisCommandLatencyHistogram>
> = {
  append: createRedisCommandLatencyHistogram(),
  read: createRedisCommandLatencyHistogram(),
  ack: createRedisCommandLatencyHistogram(),
  trim: createRedisCommandLatencyHistogram(),
};

/**
 * Batch-size histogram for the pipelined `appendAgentEventFramesBatch` fan-out.
 * Buckets are absolute counts (not bytes/seconds) so we keep a small fixed
 * ladder tuned for typical room sizes and saturate on the `+Inf` bucket
 * for extreme outliers. Exposed as `plug_agent_event_stream_batch_size`.
 */
const BATCH_SIZE_BUCKETS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000,
] as const;
const batchSizeBucketCounts = new Array<number>(BATCH_SIZE_BUCKETS.length).fill(0);
let batchSizeSum = 0;
let batchSizeCount = 0;

export const observeAgentEventStreamLatency = (
  op: AgentEventStreamLatencyOp,
  durationMs: number,
): void => {
  latencyHistograms[op].observe(durationMs);
};

let redisUrlConfigured: 0 | 1 = 0;
let redisStoreActive: 0 | 1 = 0;
let connectionEventsTotal = 0;
let fallbackEventsTotal = 0;
let runtimeCommandErrorEventsTotal = 0;
let appendsTotal = 0;
let backlogReadsTotal = 0;
let backlogEntriesDeliveredTotal = 0;
let acksTotal = 0;
let droppedTotal = 0;
let batchAppendsTotal = 0;
let batchPartialFailuresTotal = 0;
let lastConnectionAtMs = 0;
let lastFallbackAtMs = 0;

export const noteAgentEventStreamSkippedEmptyUrl = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
};

export const noteAgentEventStreamConnected = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 1;
  connectionEventsTotal += 1;
  lastConnectionAtMs = Date.now();
};

export const noteAgentEventStreamFallback = (): void => {
  redisUrlConfigured = 1;
  redisStoreActive = 0;
  fallbackEventsTotal += 1;
  lastFallbackAtMs = Date.now();
};

export const noteAgentEventStreamDisconnected = (): void => {
  redisStoreActive = 0;
};

export const noteAgentEventStreamCommandError = (): void => {
  runtimeCommandErrorEventsTotal += 1;
};

export const noteAgentEventStreamAppend = (): void => {
  appendsTotal += 1;
};

export const noteAgentEventStreamBacklogRead = (entriesDelivered: number): void => {
  backlogReadsTotal += 1;
  if (entriesDelivered > 0) {
    backlogEntriesDeliveredTotal += entriesDelivered;
  }
};

export const noteAgentEventStreamAck = (): void => {
  acksTotal += 1;
};

export const noteAgentEventStreamDropped = (): void => {
  droppedTotal += 1;
};

/**
 * Records one pipelined append batch with its size. Each invocation increments
 * `batchAppendsTotal`, the size histogram, and pushes the size into the
 * monotonic sum. Pass the count of entries the caller actually attempted (not
 * filtered by allowlist).
 */
export const noteAgentEventStreamBatchAppend = (entries: number): void => {
  if (!Number.isFinite(entries) || entries <= 0) {
    return;
  }
  batchAppendsTotal += 1;
  batchSizeSum += entries;
  batchSizeCount += 1;
  for (let i = 0; i < BATCH_SIZE_BUCKETS.length; i += 1) {
    if (entries <= (BATCH_SIZE_BUCKETS[i] ?? 0)) {
      batchSizeBucketCounts[i] = (batchSizeBucketCounts[i] ?? 0) + 1;
      return;
    }
  }
};

/**
 * Increments the partial-failure counter when a pipelined `MULTI/EXEC` returns
 * a result array that contains at least one rejected reply or a falsy value
 * for an entry that was successfully enqueued. Distinguishes from a global
 * exec error (which uses `noteAgentEventStreamCommandError`).
 */
export const noteAgentEventStreamBatchPartialFailure = (failed: number): void => {
  if (!Number.isFinite(failed) || failed <= 0) {
    return;
  }
  batchPartialFailuresTotal += failed;
};

export interface AgentEventStreamBatchSizeHistogramSnapshot {
  readonly buckets: readonly { readonly le: string; readonly count: number }[];
  readonly count: number;
  readonly sum: number;
}

const buildBatchSizeSnapshot = (): AgentEventStreamBatchSizeHistogramSnapshot => {
  let cumulative = 0;
  const buckets: { readonly le: string; readonly count: number }[] = [];
  for (let i = 0; i < BATCH_SIZE_BUCKETS.length; i += 1) {
    cumulative += batchSizeBucketCounts[i] ?? 0;
    buckets.push({ le: String(BATCH_SIZE_BUCKETS[i]), count: cumulative });
  }
  return { buckets, count: batchSizeCount, sum: batchSizeSum };
};

export const getAgentEventStreamMetricsSnapshot = (): {
  readonly redisUrlConfigured: 0 | 1;
  readonly redisStoreActive: 0 | 1;
  readonly connectionEventsTotal: number;
  readonly fallbackEventsTotal: number;
  readonly runtimeCommandErrorEventsTotal: number;
  readonly appendsTotal: number;
  readonly backlogReadsTotal: number;
  readonly backlogEntriesDeliveredTotal: number;
  readonly acksTotal: number;
  readonly droppedTotal: number;
  readonly batchAppendsTotal: number;
  readonly batchPartialFailuresTotal: number;
  readonly batchSize: AgentEventStreamBatchSizeHistogramSnapshot;
  readonly lastConnectionAtMs: number;
  readonly lastFallbackAtMs: number;
  readonly latency: Record<AgentEventStreamLatencyOp, RedisCommandLatencyHistogramSnapshot>;
} => ({
  redisUrlConfigured,
  redisStoreActive,
  connectionEventsTotal,
  fallbackEventsTotal,
  runtimeCommandErrorEventsTotal,
  appendsTotal,
  backlogReadsTotal,
  backlogEntriesDeliveredTotal,
  acksTotal,
  droppedTotal,
  batchAppendsTotal,
  batchPartialFailuresTotal,
  batchSize: buildBatchSizeSnapshot(),
  lastConnectionAtMs,
  lastFallbackAtMs,
  latency: {
    append: latencyHistograms.append.snapshot(),
    read: latencyHistograms.read.snapshot(),
    ack: latencyHistograms.ack.snapshot(),
    trim: latencyHistograms.trim.snapshot(),
  },
});

export const resetAgentEventStreamMetricsForTests = (): void => {
  redisUrlConfigured = 0;
  redisStoreActive = 0;
  connectionEventsTotal = 0;
  fallbackEventsTotal = 0;
  runtimeCommandErrorEventsTotal = 0;
  appendsTotal = 0;
  backlogReadsTotal = 0;
  backlogEntriesDeliveredTotal = 0;
  acksTotal = 0;
  droppedTotal = 0;
  batchAppendsTotal = 0;
  batchPartialFailuresTotal = 0;
  for (let i = 0; i < batchSizeBucketCounts.length; i += 1) {
    batchSizeBucketCounts[i] = 0;
  }
  batchSizeSum = 0;
  batchSizeCount = 0;
  lastConnectionAtMs = 0;
  lastFallbackAtMs = 0;
  latencyHistograms.append.reset();
  latencyHistograms.read.reset();
  latencyHistograms.ack.reset();
  latencyHistograms.trim.reset();
};
