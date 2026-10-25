import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  recordHttpRequest,
  resetHttpRedMetrics,
  getHttpRedMetricsSnapshot,
} from "../../src/shared/metrics/http_red.metrics";
import {
  observeRestBridgeLatency,
  resetRestBridgeMetrics,
  getRestBridgeMetricsSnapshot,
} from "../../src/application/services/rest_bridge_metrics.service";

it("measures request metric recording with periodic scrapes", () => {
  const iterations = 200_000;
  const results: { name: string; samplesMs: number[]; medianMs: number }[] = [];
  for (const kind of ["http_fast", "http_mixed", "rest_latency"] as const) {
    for (const scrapeEvery of [0, 1000]) {
      const samplesMs: number[] = [];
      for (let repeat = 0; repeat < 9; repeat += 1) {
        resetHttpRedMetrics();
        resetRestBridgeMetrics();
        const start = performance.now();
        for (let i = 0; i < iterations; i += 1) {
          if (kind === "rest_latency") observeRestBridgeLatency(i % 1000);
          else
            recordHttpRequest({
              method: "GET",
              route: "/api/v1/agents",
              status: 200,
              durationSeconds: kind === "http_fast" ? 0.001 : (i % 40000) / 1000,
            });
          if (scrapeEvery > 0 && (i + 1) % scrapeEvery === 0) {
            if (kind === "rest_latency") getRestBridgeMetricsSnapshot();
            else getHttpRedMetricsSnapshot();
          }
        }
        const elapsed = performance.now() - start;
        if (repeat >= 2) samplesMs.push(elapsed);
        if (kind === "rest_latency")
          expect(getRestBridgeMetricsSnapshot().latencyCount).toBe(iterations);
        else expect(getHttpRedMetricsSnapshot().requestsTotal[0]?.value).toBe(iterations);
      }
      results.push({
        name: `${kind}_scrape_${scrapeEvery}`,
        samplesMs,
        medianMs: [...samplesMs].sort((a, b) => a - b)[3]!,
      });
    }
  }
  resetHttpRedMetrics();
  resetRestBridgeMetrics();
  const output = process.env.REST_METRICS_BENCH_REPORT ?? "tmp/rest-metrics-bench.json";
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      { nodeVersion: process.version, platform: process.platform, iterations, results },
      null,
      2,
    ),
  );
});
