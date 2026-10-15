import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import type { RestApiBenchReport } from "../../performance/rest_api_bench_harness";
import {
  aggregateRestApiBenchReports,
  restApiBenchComparisonErrors,
  REST_BENCH_COMPARISON_SCHEDULE,
} from "../../performance/rest_api_bench_reports";

const report = (): RestApiBenchReport => {
  const config = {
    warmup: 16,
    iterations: 64,
    repeats: 9,
    agents: 1000,
    registry: 10000,
    refreshConcurrency: "4",
    scenarioFilter: "all",
  };
  return {
    harnessVersion: 4,
    config,
    configFingerprint: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    nodeVersion: "v24.21.0",
    platform: "linux",
    versions: { prisma: "test", postgres: "test", redis: "test" },
    scenarios: [
      {
        name: "catalog_many",
        p50Ms: 5,
        p95Ms: 10,
        p99Ms: 15,
        throughputPerSec: 100,
        heapGrowthBytes: 1000,
        retainedHeapGrowthBytes: 100,
        heapStartBytes: 2000,
        heapAfterGcBytes: 2100,
        rssPeakBytes: 5000,
        cpuUserMs: 1,
        cpuSystemMs: 1,
        eventLoopDelayP95Ms: 1,
        sqlQueries: 128,
        redisCommands: 0,
        peakActiveRpcs: 0,
        errors: 0,
        responseDigest: "unchanged-response",
        refreshWaitMs: 0,
        refreshWaitingPeak: 0,
        timeouts: 0,
      },
    ],
  };
};

describe("REST benchmark comparison", () => {
  it("should balance trial count and position without result-dependent retries", () => {
    const positions = (label: string): number[] =>
      REST_BENCH_COMPARISON_SCHEDULE.flatMap((value, index) => (value === label ? [index] : []));
    expect(positions("base")).toHaveLength(4);
    expect(positions("head")).toHaveLength(4);
    expect(positions("base").reduce((sum, index) => sum + index, 0)).toBe(
      positions("head").reduce((sum, index) => sum + index, 0),
    );
  });

  it("should retain every trial and use the median rather than the fastest", () => {
    const trials = [10, 12, 14, 100].map((p95Ms) => {
      const trial = report();
      trial.scenarios[0] = { ...trial.scenarios[0]!, p95Ms };
      return trial;
    });
    const result = aggregateRestApiBenchReports(trials);
    expect(result.scenarios[0]!.p95Ms).toBe(13);
    expect(result.scenarios[0]!.repetitions).toEqual(trials.map((trial) => trial.scenarios[0]));
    expect(restApiBenchComparisonErrors(result)).toEqual([]);
    expect(() => aggregateRestApiBenchReports(trials.slice(0, 3))).toThrow("exactly four");
  });

  it.each([
    ["p95Ms", 10.6, "p95"],
    ["throughputPerSec", 84, "throughput"],
    ["heapGrowthBytes", 1101, "heap"],
  ] as const)(
    "should reject a consistent %s regression after aggregation",
    (key, value, message) => {
      const base = aggregateRestApiBenchReports(Array.from({ length: 4 }, report));
      const head = aggregateRestApiBenchReports(
        Array.from({ length: 4 }, () => {
          const trial = report();
          trial.scenarios[0] = { ...trial.scenarios[0]!, [key]: value };
          return trial;
        }),
      );
      expect(restApiBenchComparisonErrors(head, base).join("\n")).toContain(message);
    },
  );

  it("should preserve one failed response or timeout even when other trials pass", () => {
    const trials = Array.from({ length: 4 }, report);
    trials[2]!.scenarios[0] = { ...trials[2]!.scenarios[0]!, errors: 1, timeouts: 1 };
    expect(restApiBenchComparisonErrors(aggregateRestApiBenchReports(trials))).toEqual([
      "catalog_many: response errors",
      "catalog_many: timeouts",
    ]);
  });

  it("should reject changed response contents and mismatched trial configurations", () => {
    const trials = Array.from({ length: 4 }, report);
    trials[1]!.scenarios[0] = { ...trials[1]!.scenarios[0]!, responseDigest: "changed" };
    expect(() => aggregateRestApiBenchReports(trials)).toThrow("response changed");
    trials[1] = { ...report(), nodeVersion: "v26.0.0" };
    expect(() => aggregateRestApiBenchReports(trials)).toThrow("same harness");
  });

  it("should refuse database orchestration without isolated-test authorization", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/run-rest-bench-comparison.mjs", "--base", "."],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", REST_BENCH_ISOLATED_DATABASE: "false" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("explicit isolated database opt-in");
  });
});
