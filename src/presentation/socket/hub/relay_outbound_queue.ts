/**
 * Serializes hub → consumer relay emits per JSON-RPC `requestId` so async gzip
 * (`encodePayloadFrameBridge`) cannot reorder `relay:rpc.response` / `relay:rpc.chunk` / `relay:rpc.complete`.
 */

import { encodePayloadFrameBridge, type PayloadFrameEnvelope } from "../../../shared/utils/payload_frame";
import { logger } from "../../../shared/utils/logger";

const tailByRequestId = new Map<string, Promise<void>>();

const metrics = {
  jobsFinishedTotal: 0,
  jobsFailedTotal: 0,
  jobDurationSumMs: 0,
  jobDurationMaxMs: 0,
};

export type RelayOutboundQueueMetricsSnapshot = {
  readonly jobsFinishedTotal: number;
  readonly jobsFailedTotal: number;
  readonly jobDurationSumMs: number;
  readonly jobDurationAvgMs: number;
  readonly jobDurationMaxMs: number;
  readonly inflightRequestIds: number;
};

export const getRelayOutboundQueueMetricsSnapshot = (): RelayOutboundQueueMetricsSnapshot => {
  const finished = metrics.jobsFinishedTotal;
  return {
    jobsFinishedTotal: finished,
    jobsFailedTotal: metrics.jobsFailedTotal,
    jobDurationSumMs: metrics.jobDurationSumMs,
    jobDurationAvgMs: finished > 0 ? Number((metrics.jobDurationSumMs / finished).toFixed(4)) : 0,
    jobDurationMaxMs: metrics.jobDurationMaxMs,
    inflightRequestIds: tailByRequestId.size,
  };
};

const resetRelayOutboundQueueMetrics = (): void => {
  metrics.jobsFinishedTotal = 0;
  metrics.jobsFailedTotal = 0;
  metrics.jobDurationSumMs = 0;
  metrics.jobDurationMaxMs = 0;
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
  const prev = tailByRequestId.get(requestId) ?? Promise.resolve();
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
    }
  });
  tailByRequestId.set(requestId, next);
  void next.finally(() => {
    if (tailByRequestId.get(requestId) === next) {
      tailByRequestId.delete(requestId);
    }
  });
};

export const encodeRelayOutboundFrame = async (
  data: unknown,
  requestId: string,
): Promise<PayloadFrameEnvelope> =>
  encodePayloadFrameBridge(data, { requestId, omitTraceId: true });
