/**
 * In-memory metrics for REST bridge (POST /api/v1/agents/commands).
 * Exposed via GET /metrics for observability.
 */

import { percentile } from "../../shared/utils/percentile";

const latencySamplesMax = 256;
const latencySamples: number[] = [];
let latencyCount = 0;
let latencyTotalMs = 0;
let latencyMaxMs = 0;

let restBridgeRequestsTotal = 0;
let restBridgeRequestsSuccessTotal = 0;
let restBridgeRequestsFailedTotal = 0;

export const incrementRestBridgeRequest = (): void => {
  restBridgeRequestsTotal += 1;
};

export const incrementRestBridgeRequestSuccess = (): void => {
  restBridgeRequestsSuccessTotal += 1;
};

export const incrementRestBridgeRequestFailed = (): void => {
  restBridgeRequestsFailedTotal += 1;
};

export const observeRestBridgeLatency = (elapsedMs: number): void => {
  const safeMs = Math.max(0, elapsedMs);
  latencyCount += 1;
  latencyTotalMs += safeMs;
  latencyMaxMs = Math.max(latencyMaxMs, safeMs);
  latencySamples.push(safeMs);
  if (latencySamples.length > latencySamplesMax) {
    latencySamples.shift();
  }
};

export const getRestBridgeMetricsSnapshot = (): {
  requestsTotal: number;
  requestsSuccessTotal: number;
  requestsFailedTotal: number;
  latencyCount: number;
  latencyAvgMs: number;
  latencyMaxMs: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
} => ({
  requestsTotal: restBridgeRequestsTotal,
  requestsSuccessTotal: restBridgeRequestsSuccessTotal,
  requestsFailedTotal: restBridgeRequestsFailedTotal,
  latencyCount,
  latencyAvgMs: latencyCount > 0 ? Number((latencyTotalMs / latencyCount).toFixed(2)) : 0,
  latencyMaxMs,
  latencyP95Ms: Number(percentile(latencySamples, 95).toFixed(2)),
  latencyP99Ms: Number(percentile(latencySamples, 99).toFixed(2)),
});

export const resetRestBridgeMetrics = (): void => {
  restBridgeRequestsTotal = 0;
  restBridgeRequestsSuccessTotal = 0;
  restBridgeRequestsFailedTotal = 0;
  latencySamples.length = 0;
  latencyCount = 0;
  latencyTotalMs = 0;
  latencyMaxMs = 0;
};
