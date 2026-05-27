#!/usr/bin/env node
/**
 * Microbench for the stream fan-out path.
 *
 * Compares the legacy per-recipient sequential `XADD` + `PEXPIRE` (2N RTTs
 * concurrent) against the pipelined `appendAgentEventFramesBatch` (1 RTT
 * regardless of recipient count). Requires a reachable Redis instance via
 * `BENCH_REDIS_URL` (default `redis://127.0.0.1:6379`).
 *
 * Usage:
 *   BENCH=1 BENCH_REDIS_URL=redis://localhost:6379 \
 *     npx tsx scripts/bench-stream-fanout.ts \
 *       --recipients 10,50,200 --iterations 200 --max-len 1000 --ttl-ms 60000
 *
 * Output: p50/p95/p99 latency in ms for each scenario (legacy vs batch) and
 * a delta percentage. The script exits non-zero on connection failure but
 * reports per-scenario errors as warnings so a partial run still produces
 * actionable data.
 */

import { performance } from "node:perf_hooks";

import { createClient } from "redis";

interface ParsedArgs {
  readonly recipients: readonly number[];
  readonly iterations: number;
  readonly maxLen: number;
  readonly ttlMs: number;
  readonly url: string;
}

const DEFAULTS: ParsedArgs = {
  recipients: [10, 50, 200],
  iterations: 200,
  maxLen: 1_000,
  ttlMs: 60_000,
  url: process.env["BENCH_REDIS_URL"] ?? "redis://127.0.0.1:6379",
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const overrides: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      continue;
    }
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (typeof value === "string" && !value.startsWith("--")) {
      overrides[key] = value;
      i += 1;
    }
  }
  const recipients =
    overrides["recipients"] !== undefined
      ? overrides["recipients"]
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
      : DEFAULTS.recipients;
  return {
    recipients: recipients.length > 0 ? recipients : DEFAULTS.recipients,
    iterations:
      Number.parseInt(overrides["iterations"] ?? "", 10) > 0
        ? Number.parseInt(overrides["iterations"] ?? "", 10)
        : DEFAULTS.iterations,
    maxLen:
      Number.parseInt(overrides["max-len"] ?? "", 10) > 0
        ? Number.parseInt(overrides["max-len"] ?? "", 10)
        : DEFAULTS.maxLen,
    ttlMs:
      Number.parseInt(overrides["ttl-ms"] ?? "", 10) > 0
        ? Number.parseInt(overrides["ttl-ms"] ?? "", 10)
        : DEFAULTS.ttlMs,
    url: overrides["url"] ?? DEFAULTS.url,
  };
};

const quantile = (sortedValues: readonly number[], q: number): number => {
  if (sortedValues.length === 0) {
    return 0;
  }
  const idx = Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length));
  return sortedValues[idx] ?? 0;
};

const buildFrame = (i: number): { eventId: string; payload: string } => ({
  eventId: `bench-evt-${i}`,
  payload: JSON.stringify({ i, t: Date.now(), pad: "x".repeat(64) }),
});

const benchLegacy = async (
  client: ReturnType<typeof createClient>,
  args: ParsedArgs,
  recipients: number,
): Promise<readonly number[]> => {
  const samples: number[] = [];
  for (let it = 0; it < args.iterations; it += 1) {
    const frame = buildFrame(it);
    const started = performance.now();
    const tasks: Promise<unknown>[] = [];
    for (let r = 0; r < recipients; r += 1) {
      const key = `plug_agent_stream_bench_legacy:{plug}:bench-${r}`;
      tasks.push(
        (async () => {
          await client.xAdd(
            key,
            "*",
            {
              schemaVersion: "1",
              eventId: frame.eventId,
              eventName: "client:custom.bench",
              emittedAt: new Date().toISOString(),
              payload: frame.payload,
            },
            {
              TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: args.maxLen },
            },
          );
          if (args.ttlMs > 0) {
            await client.pExpire(key, args.ttlMs);
          }
        })(),
      );
    }
    await Promise.all(tasks);
    samples.push(performance.now() - started);
  }
  return samples;
};

const benchBatch = async (
  client: ReturnType<typeof createClient>,
  args: ParsedArgs,
  recipients: number,
): Promise<readonly number[]> => {
  const samples: number[] = [];
  for (let it = 0; it < args.iterations; it += 1) {
    const frame = buildFrame(it);
    const started = performance.now();
    const tx = client.multi();
    for (let r = 0; r < recipients; r += 1) {
      const key = `plug_agent_stream_bench_batch:{plug}:bench-${r}`;
      tx.xAdd(
        key,
        "*",
        {
          schemaVersion: "1",
          eventId: frame.eventId,
          eventName: "client:custom.bench",
          emittedAt: new Date().toISOString(),
          payload: frame.payload,
        },
        {
          TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: args.maxLen },
        },
      );
      if (args.ttlMs > 0) {
        tx.pExpire(key, args.ttlMs);
      }
    }
    await tx.exec();
    samples.push(performance.now() - started);
  }
  return samples;
};

const summarize = (label: string, samples: readonly number[]): void => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const avg = sum / Math.max(1, sorted.length);
  const p50 = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const p99 = quantile(sorted, 0.99);
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(28)} count=${String(sorted.length).padStart(4)} avg=${avg
      .toFixed(2)
      .padStart(7)}ms p50=${p50.toFixed(2).padStart(7)}ms p95=${p95
      .toFixed(2)
      .padStart(7)}ms p99=${p99.toFixed(2).padStart(7)}ms`,
  );
};

const main = async (): Promise<void> => {
  if (process.env["BENCH"] !== "1") {
    // eslint-disable-next-line no-console
    console.error("[bench-stream-fanout] BENCH=1 is required to run");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const client = createClient({ url: args.url });
  client.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[bench-stream-fanout] client error:", err.message);
  });
  await client.connect();
  // eslint-disable-next-line no-console
  console.log(
    `[bench-stream-fanout] url=${args.url} iterations=${args.iterations} maxLen=${args.maxLen} ttlMs=${args.ttlMs}`,
  );
  for (const recipients of args.recipients) {
    // eslint-disable-next-line no-console
    console.log(`\n# scenario: recipients=${recipients}`);
    try {
      const legacySamples = await benchLegacy(client, args, recipients);
      summarize("legacy (concurrent xAdd)", legacySamples);
      const batchSamples = await benchBatch(client, args, recipients);
      summarize("batch (multi/exec)", batchSamples);
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bench-stream-fanout] scenario recipients=${recipients} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await client.quit();
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[bench-stream-fanout] fatal:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
