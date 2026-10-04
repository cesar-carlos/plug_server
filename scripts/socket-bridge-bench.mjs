#!/usr/bin/env node
"use strict";

/**
 * Writes tests/fixtures/performance/socket_bridge_baseline.json from the
 * Vitest report at tmp/socket-bridge-bench.json. Heap numbers depend on the
 * Vitest module graph, so the report must come from
 * `npm run test:perf:socket-bridge`.
 *
 * Usage:
 *   npm run test:perf:socket-bridge
 *   node --import tsx scripts/socket-bridge-bench.mjs --update-baseline
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

if (!process.argv.includes("--update-baseline")) {
  console.error(
    "Run npm run test:perf:socket-bridge, then node --import tsx scripts/socket-bridge-bench.mjs --update-baseline.",
  );
  process.exit(1);
}

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
  harnessVersion: report.harnessVersion,
  configFingerprint: report.configFingerprint,
  nodeVersion: report.nodeVersion,
  platform: report.platform,
  note: "Local Windows/Vitest baseline with audit sampling disabled and three complete benchmark rounds. Gate: +5% p95 with a 0.03/0.08 ms noise floor on sub-millisecond paths, -15% unary/slow throughput, -30% normal-stream throughput, +10% median sampled peak heap. CI compares with the base commit on the same runner. Recalibrate only with repeated isolated measurements.",
  config: report.config,
  heapUsedPeakBytes: report.heapUsedPeakBytes,
  heapUsedGrowthPeakBytes: report.heapUsedGrowthPeakBytes,
  scenarios: report.scenarios,
};
writeFileSync(fixturePath, `${JSON.stringify(baseline, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
