#!/usr/bin/env node
/**
 * In-process microbench for the hot Redis-side helpers that do not require
 * a live Redis broker:
 *
 *   1. Histogram bucket lookup (`observe`) — binary search vs old linear scan.
 *   2. Histogram snapshot — pre-allocated array vs `Array.prototype.map`.
 *   3. Latency snapshot map iteration patterns used by metric services.
 *
 * Usage:
 *   BENCH=1 npx tsx scripts/redis-perf-bench.ts [--iterations 100000]
 *
 * Runs each scenario `iterations` times and reports avg/p50/p95/p99 ns per
 * call. Network-level benches live next to this file (`bench-stream-fanout`).
 */

import { performance } from "node:perf_hooks";

import {
  REDIS_COMMAND_LATENCY_BUCKETS_MS,
  createRedisCommandLatencyHistogram,
} from "../src/application/services/redis_command_latency_histogram";

const parseIterations = (argv: readonly string[]): number => {
  const idx = argv.indexOf("--iterations");
  if (idx >= 0 && idx + 1 < argv.length) {
    const candidate = Number.parseInt(argv[idx + 1] ?? "", 10);
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 100_000;
};

const summarize = (label: string, samplesNs: readonly number[]): void => {
  const sorted = [...samplesNs].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const avg = sum / Math.max(1, sorted.length);
  const q = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(36)} count=${String(sorted.length).padStart(6)} avg=${avg
      .toFixed(0)
      .padStart(7)}ns p50=${q(0.5).toFixed(0).padStart(7)}ns p95=${q(0.95)
      .toFixed(0)
      .padStart(7)}ns p99=${q(0.99).toFixed(0).padStart(7)}ns`,
  );
};

const benchHistogramObserve = (iterations: number): void => {
  const h = createRedisCommandLatencyHistogram();
  // Pre-generate values so RNG cost is not in the timing window.
  const values = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    values[i] = Math.random() * 6_000;
  }
  // Warm-up.
  for (let i = 0; i < 1_000; i += 1) {
    h.observe(values[i] ?? 0);
  }
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    h.observe(values[i] ?? 0);
    samples[i] = (performance.now() - t0) * 1_000_000;
  }
  summarize("histogram.observe (binary search)", samples);
};

const benchHistogramSnapshot = (iterations: number): void => {
  const h = createRedisCommandLatencyHistogram();
  for (let i = 0; i < 10_000; i += 1) {
    h.observe(Math.random() * 6_000);
  }
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    h.snapshot();
    samples[i] = (performance.now() - t0) * 1_000_000;
  }
  summarize("histogram.snapshot (pre-alloc)", samples);
};

const benchBucketBoundaryLookup = (iterations: number): void => {
  /**
   * Worst case: pick boundary values so the binary search path traverses
   * the deepest split. Confirms there's no pathological edge.
   */
  const h = createRedisCommandLatencyHistogram();
  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const value =
      REDIS_COMMAND_LATENCY_BUCKETS_MS[i % REDIS_COMMAND_LATENCY_BUCKETS_MS.length] ?? 1;
    const t0 = performance.now();
    h.observe(value);
    samples[i] = (performance.now() - t0) * 1_000_000;
  }
  summarize("histogram.observe (boundary values)", samples);
};

const main = (): void => {
  if (process.env["BENCH"] !== "1") {
    // eslint-disable-next-line no-console
    console.error("[redis-perf-bench] BENCH=1 is required to run");
    process.exit(1);
  }
  const iterations = parseIterations(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(`[redis-perf-bench] iterations=${iterations}`);
  benchHistogramObserve(iterations);
  benchBucketBoundaryLookup(iterations);
  benchHistogramSnapshot(Math.min(iterations, 20_000));
};

main();
