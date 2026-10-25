import { afterEach, expect, it } from "vitest";
import {
  observeRestBridgeLatency,
  getRestBridgeMetricsSnapshot,
  resetRestBridgeMetrics,
  incrementRestBridgeRequest,
  incrementRestBridgeRequestSuccess,
  incrementRestBridgeRequestFailed,
} from "../../../../src/application/services/rest_bridge_metrics.service";

afterEach(resetRestBridgeMetrics);

it("should preserve lifetime totals and percentiles of the most recent 256 observations across wraps", () => {
  const values: number[] = [];
  for (let i = 0; i < 800; i += 1) {
    const elapsed = i % 17 === 0 ? -1 : (i * 73) % 1001;
    values.push(Math.max(0, elapsed));
    observeRestBridgeLatency(elapsed);
    if ([0, 254, 255, 256, 511, 799].includes(i)) {
      const sorted = values.slice(-256).sort((a, b) => a - b);
      const snapshot = getRestBridgeMetricsSnapshot();
      expect(snapshot.latencyCount).toBe(values.length);
      expect(snapshot.latencyAvgMs).toBe(
        Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
      );
      expect(snapshot.latencyMaxMs).toBe(Math.max(...values));
      expect(snapshot.latencyP95Ms).toBe(sorted[Math.ceil(sorted.length * 0.95) - 1]);
      expect(snapshot.latencyP99Ms).toBe(sorted[Math.ceil(sorted.length * 0.99) - 1]);
      expect(getRestBridgeMetricsSnapshot()).toEqual(snapshot);
    }
  }
});

it("should clear all samples and counters on reset", () => {
  for (let i = 0; i < 300; i += 1) observeRestBridgeLatency(100);
  incrementRestBridgeRequest();
  incrementRestBridgeRequestSuccess();
  incrementRestBridgeRequestFailed();
  expect(getRestBridgeMetricsSnapshot()).toMatchObject({
    requestsTotal: 1,
    requestsSuccessTotal: 1,
    requestsFailedTotal: 1,
  });
  resetRestBridgeMetrics();
  expect(Object.values(getRestBridgeMetricsSnapshot()).every((value) => value === 0)).toBe(true);
  observeRestBridgeLatency(2);
  expect(getRestBridgeMetricsSnapshot()).toMatchObject({
    latencyCount: 1,
    latencyAvgMs: 2,
    latencyP95Ms: 2,
    latencyP99Ms: 2,
  });
});
