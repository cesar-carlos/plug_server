import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { percentile } from "../../src/shared/utils/percentile";
import {
  buildRelayHubMetricsSnapshot,
  observeAgentLatency,
  resetRelayHubHealthAndMetrics,
} from "../../src/presentation/socket/hub/relay/bridge_relay_health_metrics";

afterEach(resetRelayHubHealthAndMetrics);

it("measures percentile distributions and sparse/full agent metric updates", () => {
  const samplesPerAgent = 256;
  const agentCount = 512;
  const iterations = 2000;
  const distributions = {
    equal: Array.from({ length: samplesPerAgent }, () => 10),
    repeated: Array.from({ length: samplesPerAgent }, (_, i) => i % 8),
    varied: Array.from({ length: samplesPerAgent }, (_, i) => (i * 73) % 257),
  };
  const results: { name: string; samplesMs: number[]; medianMs: number }[] = [];
  const measure = (name: string, work: () => void): void => {
    const samplesMs: number[] = [];
    for (let repeat = 0; repeat < 9; repeat += 1) {
      const start = performance.now();
      work();
      const elapsed = performance.now() - start;
      if (repeat >= 2) samplesMs.push(elapsed);
    }
    results.push({ name, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[3]! });
  };
  for (const [name, values] of Object.entries(distributions)) {
    const sorted = [...values].sort((a, b) => a - b);
    const expected = sorted[Math.ceil(values.length * 0.95) - 1]!;
    measure(`percentile_${name}`, () => {
      let total = 0;
      for (let i = 0; i < iterations; i += 1) total += percentile(values, 95);
      expect(total).toBe(expected * iterations);
    });
  }
  const snapshot = (): ReturnType<typeof buildRelayHubMetricsSnapshot> =>
    buildRelayHubMetricsSnapshot({
      activeStreams: 0,
      restMaterializeStreamsInFlight: 0,
      useFastQueueSnapshot: true,
    });
  for (const updatedAgents of [1, agentCount]) {
    resetRelayHubHealthAndMetrics();
    for (let agent = 0; agent < agentCount; agent += 1) {
      for (const value of distributions.varied) observeAgentLatency(`agent-${agent}`, value);
    }
    snapshot();
    measure(`snapshot_updated_${updatedAgents}_of_${agentCount}`, () => {
      for (let i = 0; i < 20; i += 1) {
        for (let agent = 0; agent < updatedAgents; agent += 1)
          observeAgentLatency(`agent-${agent}`, i);
        expect(snapshot().latencyByAgent).toHaveLength(agentCount);
      }
    });
  }
  const output = process.env.SOCKET_METRICS_BENCH_REPORT ?? "tmp/socket-metrics-bench.json";
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        nodeVersion: process.version,
        platform: process.platform,
        samplesPerAgent,
        agentCount,
        iterations,
        snapshotsPerSample: 20,
        results,
      },
      null,
      2,
    ),
  );
});
