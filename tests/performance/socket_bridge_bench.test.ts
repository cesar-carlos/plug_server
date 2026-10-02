import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SOCKET_BRIDGE_BENCH_CI_OPTIONS,
  runStableSocketBridgeBench,
  type SocketBridgeBenchReport,
} from "./socket_bridge_bench_harness";

interface BaselineScenario {
  readonly name: string;
  readonly p95Ms: number;
  readonly throughputPerSec: number;
}

interface BaselineFile {
  readonly harnessVersion?: number;
  readonly configFingerprint?: string;
  readonly env?: SocketBridgeBenchReport["env"];
  readonly nodeVersion: string;
  readonly platform: string;
  readonly config: {
    readonly warmup: number;
    readonly iterations: number;
    readonly streamChunks: number;
    readonly repeats: number;
  };
  readonly heapUsedGrowthPeakBytes?: number;
  readonly scenarios: readonly BaselineScenario[];
}

const baselinePath = process.env.SOCKET_BRIDGE_BENCH_BASELINE_PATH;
const baseline = JSON.parse(
  readFileSync(
    baselinePath ??
      path.join(process.cwd(), "tests/fixtures/performance/socket_bridge_baseline.json"),
    "utf8",
  ),
) as BaselineFile;

describe("socket bridge performance bench", () => {
  it("keeps stream order and stays within relative SLO gates", async () => {
    const report = await runStableSocketBridgeBench(SOCKET_BRIDGE_BENCH_CI_OPTIONS);
    mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
    writeFileSync(
      path.join(process.cwd(), "tmp", "socket-bridge-bench.json"),
      JSON.stringify(report, null, 2),
    );
    // A committed fixture cannot account for competing processes on a developer
    // workstation. CI supplies a fresh base-commit report from the same runner.
    const comparable =
      baseline.harnessVersion === report.harnessVersion &&
      (baselinePath !== undefined ||
        (process.env.SOCKET_BRIDGE_BENCH_COMPARE_LOCAL === "1" &&
          baseline.platform === report.platform &&
          baseline.nodeVersion === report.nodeVersion));
    if (baselinePath !== undefined) {
      expect(baseline.harnessVersion, "base and head must use the same harness").toBe(
        report.harnessVersion,
      );
    }
    if (comparable) {
      expect(report.platform).toBe(baseline.platform);
      expect(report.nodeVersion).toBe(baseline.nodeVersion);
      expect(report.config).toEqual(baseline.config);
      expect(report.configFingerprint, "runtime settings must match").toBe(
        baseline.configFingerprint,
      );
      expect(report.env).toEqual(baseline.env);
      expect(report.scenarios.map((scenario) => scenario.name)).toEqual(
        baseline.scenarios.map((scenario) => scenario.name),
      );
    }
    for (const scenario of report.scenarios) {
      expect(scenario.chunksLost, scenario.name).toBe(0);
      expect(scenario.orderOk, scenario.name).toBe(true);
      expect(scenario.duplicateChunks, scenario.name).toBe(0);
      if (scenario.name === "unary_gzip") expect(scenario.gzipFrames).toBe(scenario.samples);
      const reference = baseline.scenarios.find((item) => item.name === scenario.name);
      if (comparable) expect(reference, scenario.name).toBeDefined();
      if (!reference || !comparable) {
        continue;
      }
      // Sub-millisecond paths have measurable scheduler/JIT noise even after
      // warmup. The deliberately slow stream keeps a strict relative limit.
      const p95NoiseFloorMs =
        scenario.name === "rest_handler_cpu_delay"
          ? 0
          : scenario.name === "rest_handler_stream"
            ? 0.08
            : 0.03;
      const throughputFloor = scenario.name === "rest_handler_stream" ? 0.7 : 0.85;
      expect(scenario.p95Ms, scenario.name).toBeLessThanOrEqual(
        Math.max(reference.p95Ms * 1.05, reference.p95Ms + p95NoiseFloorMs),
      );
      expect(scenario.throughputPerSec, scenario.name).toBeGreaterThanOrEqual(
        reference.throughputPerSec * throughputFloor,
      );
    }
    if (comparable && baseline.heapUsedGrowthPeakBytes !== undefined) {
      expect(report.heapUsedGrowthPeakBytes).toBeLessThanOrEqual(
        baseline.heapUsedGrowthPeakBytes * 1.1,
      );
    }
    expect(report.heapUsedPeakBytes).toBeGreaterThan(0);
    expect(report.heapUsedGrowthPeakBytes).toBeGreaterThan(0);
  });
});
