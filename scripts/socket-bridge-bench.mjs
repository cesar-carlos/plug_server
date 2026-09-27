#!/usr/bin/env node
"use strict";

/**
 * Isolated hub inbound bench. Prints JSON (no secrets).
 * Usage: npx vitest run tests/performance/socket_bridge_bench.test.ts
 *        node --import tsx scripts/socket-bridge-bench.mjs
 *        npm run test:perf:socket-bridge
 *        node --import tsx scripts/socket-bridge-bench.mjs --update-baseline
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.NODE_ENV = "test";
process.env.SOCKET_AUDIT_HIGH_VOLUME_SAMPLE_PERCENT = "0";

const harnessUrl = pathToFileURL(
  path.join(process.cwd(), "tests/performance/socket_bridge_bench_harness.ts"),
).href;

const updateBaseline = process.argv.includes("--update-baseline");
if (updateBaseline) {
  // The fixture must come from Vitest: its loaded module graph materially
  // affects absolute heap measurements compared with this standalone script.
  const report = JSON.parse(
    readFileSync(path.join(process.cwd(), "tmp/socket-bridge-bench.json"), "utf8"),
  );
  if (report.nodeVersion !== process.version || report.platform !== process.platform) {
    throw new Error("Benchmark report does not match this Node/platform");
  }
  const fixturePath = path.join(
    process.cwd(),
    "tests/fixtures/performance/socket_bridge_baseline.json",
  );
  const baseline = {
    nodeVersion: report.nodeVersion,
    platform: report.platform,
    note: "Local Windows/Vitest baseline with audit sampling disabled and three complete benchmark rounds. Gate: +5% p95 with a 0.03/0.08 ms noise floor on sub-millisecond paths, -15% unary/slow throughput, -30% normal-stream throughput, +10% median sampled peak heap. CI compares with the base commit on the same runner. Recalibrate only with repeated isolated measurements.",
    config: report.config,
    heapUsedPeakBytes: report.heapUsedPeakBytes,
    heapUsedGrowthPeakBytes: report.heapUsedGrowthPeakBytes,
    scenarios: report.scenarios.map((scenario) => ({
      name: scenario.name,
      p95Ms: scenario.p95Ms,
      throughputPerSec: scenario.throughputPerSec,
    })),
  };
  writeFileSync(fixturePath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
} else {
  const { runStableSocketBridgeBench, SOCKET_BRIDGE_BENCH_CI_OPTIONS } = await import(harnessUrl);
  const report = await runStableSocketBridgeBench(SOCKET_BRIDGE_BENCH_CI_OPTIONS);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
