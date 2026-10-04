import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { env } from "../../src/shared/config/env";

import { percentile } from "../../src/shared/utils/percentile";
import { encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { createRpcBridgeAgentInboundHandlers } from "../../src/presentation/socket/hub/relay/rpc_bridge_agent_inbound";
import {
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetActiveStreamRegistry } from "../../src/presentation/socket/hub/registries/active_stream_registry";
import {
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetRelayOutboundQueueState } from "../../src/presentation/socket/hub/relay/relay_outbound_queue";
import { resetAgentInboundSequencerForTests } from "../../src/presentation/socket/hub/relay/agent_inbound_sequencer";
import { resetAgentInboundIngressForTests } from "../../src/presentation/socket/hub/relay/agent_inbound_ingress_guard";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { runLoopbackRelayBench } from "./socket_bridge_loopback_bench";

export interface SocketBridgeBenchScenarioResult {
  readonly name: string;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly throughputPerSec: number;
  readonly bytes: number;
  readonly originalBytes: number;
  readonly gzipFrames: number;
  readonly duplicateChunks: number;
  readonly heapUsedPeakBytes?: number;
  readonly rssPeakBytes?: number;
  readonly cpuUserMs?: number;
  readonly cpuSystemMs?: number;
  readonly eventLoopDelayP95Ms?: number;
  readonly chunksLost: number;
  readonly orderOk: boolean;
}

export interface SocketBridgeBenchReport {
  readonly harnessVersion: number;
  readonly configFingerprint: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly config: {
    readonly warmup: number;
    readonly iterations: number;
    readonly streamChunks: number;
    readonly repeats: number;
  };
  readonly env: {
    readonly nodeEnv: string;
    readonly inboundGuardMode: string;
    readonly outboundMaxPendingBytes: string;
  };
  readonly heapUsedPeakBytes: number;
  readonly heapUsedGrowthPeakBytes: number;
  readonly scenarios: readonly SocketBridgeBenchScenarioResult[];
}

export const SOCKET_BRIDGE_BENCH_CI_OPTIONS = {
  warmup: 256,
  iterations: 256,
  streamChunks: 8,
  repeats: 9,
} as const;

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const medianScenario = (
  runs: readonly SocketBridgeBenchScenarioResult[],
): SocketBridgeBenchScenarioResult => {
  const first = runs[0];
  if (!first) {
    return {
      name: "unknown",
      samples: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      throughputPerSec: 0,
      bytes: 0,
      originalBytes: 0,
      gzipFrames: 0,
      duplicateChunks: 0,
      chunksLost: 0,
      orderOk: true,
    };
  }
  return {
    name: first.name,
    samples: first.samples,
    p50Ms: median(runs.map((run) => run.p50Ms)),
    p95Ms: median(runs.map((run) => run.p95Ms)),
    p99Ms: median(runs.map((run) => run.p99Ms)),
    throughputPerSec: median(runs.map((run) => run.throughputPerSec)),
    bytes: median(runs.map((run) => run.bytes)),
    originalBytes: median(runs.map((run) => run.originalBytes)),
    gzipFrames: median(runs.map((run) => run.gzipFrames)),
    duplicateChunks: runs.reduce((sum, run) => sum + run.duplicateChunks, 0),
    ...(first.heapUsedPeakBytes !== undefined
      ? { heapUsedPeakBytes: median(runs.map((run) => run.heapUsedPeakBytes ?? 0)) }
      : {}),
    rssPeakBytes: median(runs.map((run) => run.rssPeakBytes ?? 0)),
    cpuUserMs: median(runs.map((run) => run.cpuUserMs ?? 0)),
    cpuSystemMs: median(runs.map((run) => run.cpuSystemMs ?? 0)),
    eventLoopDelayP95Ms: median(runs.map((run) => run.eventLoopDelayP95Ms ?? 0)),
    chunksLost: runs.reduce((sum, run) => sum + run.chunksLost, 0),
    orderOk: runs.every((run) => run.orderOk),
  };
};

const repeatMeasured = async (
  repeats: number,
  run: () => Promise<SocketBridgeBenchScenarioResult>,
): Promise<SocketBridgeBenchScenarioResult> => {
  const runs: SocketBridgeBenchScenarioResult[] = [];
  for (let index = 0; index < repeats; index += 1) {
    global.gc?.();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    let rssPeakBytes = process.memoryUsage().rss;
    observedScenarioHeapPeakBytes = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
      sampleHeap();
      rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
    }, 10);
    delay.enable();
    const cpuStart = process.cpuUsage();
    try {
      const result = await run();
      const cpu = process.cpuUsage(cpuStart);
      sampleHeap();
      const heapUsedPeakBytes = Math.max(
        observedScenarioHeapPeakBytes,
        result.heapUsedPeakBytes ?? 0,
      );
      observedHeapPeakBytes = Math.max(observedHeapPeakBytes, heapUsedPeakBytes);
      runs.push({
        ...result,
        heapUsedPeakBytes,
        rssPeakBytes: Math.max(rssPeakBytes, process.memoryUsage().rss),
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        eventLoopDelayP95Ms: delay.count > 0 ? delay.percentile(95) / 1_000_000 : 0,
      });
    } finally {
      clearInterval(sampler);
      delay.disable();
    }
  }
  return medianScenario(runs);
};

let observedHeapPeakBytes = 0;
let observedScenarioHeapPeakBytes = 0;
let measuredHeapBaselineBytes = 0;
let sampleHeapEnabled = false;
const sampleHeap = (): void => {
  if (!sampleHeapEnabled) {
    return;
  }
  const heap = process.memoryUsage().heapUsed;
  observedHeapPeakBytes = Math.max(observedHeapPeakBytes, heap);
  observedScenarioHeapPeakBytes = Math.max(observedScenarioHeapPeakBytes, heap);
};

const wait = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) {
      return;
    }
    await wait();
  }
  throw new Error(`Socket bridge bench operation did not complete within ${timeoutMs} ms`);
};

const measure = (
  samples: readonly number[],
): Pick<SocketBridgeBenchScenarioResult, "p50Ms" | "p95Ms" | "p99Ms" | "throughputPerSec"> => {
  const totalMs = samples.reduce((sum, value) => sum + value, 0);
  return {
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    throughputPerSec: totalMs === 0 ? 0 : (samples.length * 1000) / totalMs,
  };
};

const createTimeoutHandle = (): NodeJS.Timeout => setTimeout(() => undefined, 60_000);

/** Seeded, moderately compressible data keeps the benchmark below the 10x inflation guard. */
const makeGzipBenchText = (): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let seed = 0x12345678;
  let text = "";
  for (let index = 0; index < 8_192; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    text += alphabet[(seed >>> 0) % alphabet.length];
  }
  return text;
};

const resetBenchState = (): void => {
  resetRelayRequestRegistry();
  resetActiveStreamRegistry();
  resetRestPendingRequestsStore();
  resetRelayOutboundQueueState();
  resetAgentInboundSequencerForTests();
  resetAgentInboundIngressForTests();
};

const runUnary = async (
  iterations: number,
  gzip: boolean,
): Promise<SocketBridgeBenchScenarioResult> => {
  const samples: number[] = [];
  let bytes = 0;
  let originalBytes = 0;
  let gzipFrames = 0;
  const body = gzip
    ? { jsonrpc: "2.0", id: "req-unary", result: { blob: makeGzipBenchText() } }
    : { jsonrpc: "2.0", id: "req-unary", result: { ok: true } };
  for (let index = 0; index < iterations; index += 1) {
    resetBenchState();
    const requestId = `req-unary-${index}`;
    let delivered = false;
    const emitToConsumer = (): boolean => {
      delivered = true;
      sampleHeap();
      return true;
    };
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: () => undefined,
    });
    registerRelayRequestRoute({
      requestId,
      conversationId: "conv-bench",
      consumerSocketId: "consumer-bench",
      agentSocketId: "socket-bench",
      agentId: "agent-bench",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    const frame = encodePayloadFrame(
      { ...body, id: requestId },
      {
        requestId,
        ...(gzip ? { compressionThreshold: 1, compressionPolicy: "always_gzip" as const } : {}),
      },
    );
    bytes += frame.compressedSize;
    originalBytes += frame.originalSize;
    if (gzip && frame.cmp !== "gzip") {
      throw new Error("unary_gzip must exercise gzip, not its inflation-guard fallback");
    }
    gzipFrames += frame.cmp === "gzip" ? 1 : 0;
    const started = performance.now();
    h.handleAgentRpcResponse("socket-bench", frame);
    sampleHeap();
    await waitUntil(() => delivered);
    samples.push(performance.now() - started);
    sampleHeap();
  }
  return {
    name: gzip ? "unary_gzip" : "unary_small",
    samples: samples.length,
    bytes,
    originalBytes,
    gzipFrames,
    duplicateChunks: 0,
    chunksLost: 0,
    orderOk: true,
    ...measure(samples),
  };
};

const runStream = async (
  iterations: number,
  chunkCount: number,
  slowConsumer: boolean,
): Promise<SocketBridgeBenchScenarioResult> => {
  const samples: number[] = [];
  let bytes = 0;
  let originalBytes = 0;
  let chunksLost = 0;
  let orderOk = true;
  let duplicateChunks = 0;
  for (let index = 0; index < iterations; index += 1) {
    resetBenchState();
    const requestId = `req-stream-${index}`;
    const events: string[] = [];
    const seen = new Set<number>();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: () => true,
      emitRpcStreamPullForRoute: () => undefined,
    });
    registerRestPendingRequest({
      primaryRequestId: requestId,
      correlationIds: [requestId],
      socketId: "socket-bench",
      agentId: "agent-bench",
      createdAtMs: Date.now(),
      resolve: () => {
        events.push(socketEvents.relayRpcResponse);
      },
      reject: () => undefined,
      timeoutHandle: createTimeoutHandle(),
      acked: false,
      streamHandlers: {
        consumerSocketId: "consumer-bench",
        onChunk: (chunk) => {
          const chunkIndex = Number(chunk.chunk_index);
          if (seen.has(chunkIndex)) duplicateChunks += 1;
          if (chunkIndex !== seen.size) orderOk = false;
          seen.add(chunkIndex);
          if (slowConsumer) {
            const until = performance.now() + 1;
            while (performance.now() < until) {
              /* slow consumer */
            }
          }
          events.push(socketEvents.relayRpcChunk);
        },
        onComplete: () => {
          events.push(socketEvents.relayRpcComplete);
        },
      },
    });
    const started = performance.now();
    const open = encodePayloadFrame(
      { jsonrpc: "2.0", id: requestId, result: { stream_id: `stream-${index}` } },
      { requestId },
    );
    bytes += open.compressedSize;
    originalBytes += open.originalSize;
    h.handleAgentRpcResponse("socket-bench", open);
    sampleHeap();
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const chunk = encodePayloadFrame(
        {
          request_id: requestId,
          stream_id: `stream-${index}`,
          chunk_index: chunkIndex,
          rows: [{ n: chunkIndex }],
        },
        { requestId },
      );
      bytes += chunk.compressedSize;
      originalBytes += chunk.originalSize;
      h.handleAgentRpcChunk("socket-bench", chunk);
      sampleHeap();
    }
    const complete = encodePayloadFrame(
      {
        request_id: requestId,
        stream_id: `stream-${index}`,
        total_rows: chunkCount,
      },
      { requestId },
    );
    bytes += complete.compressedSize;
    originalBytes += complete.originalSize;
    h.handleAgentRpcComplete("socket-bench", complete);
    sampleHeap();
    await waitUntil(
      () =>
        events.filter((eventName) => eventName === socketEvents.relayRpcChunk).length >=
          chunkCount && events.includes(socketEvents.relayRpcComplete),
    );
    samples.push(performance.now() - started);
    sampleHeap();
    const chunkEvents = events.filter((eventName) => eventName === socketEvents.relayRpcChunk);
    if (chunkEvents.length < chunkCount) {
      chunksLost += chunkCount - chunkEvents.length;
    }
    const expectedHead = [
      socketEvents.relayRpcResponse,
      ...Array(chunkCount).fill(socketEvents.relayRpcChunk),
      socketEvents.relayRpcComplete,
    ];
    if (events.length >= expectedHead.length) {
      const head = events.slice(0, expectedHead.length);
      if (head.some((eventName, eventIndex) => eventName !== expectedHead[eventIndex])) {
        orderOk = false;
      }
    } else {
      orderOk = false;
    }
  }
  return {
    name: slowConsumer ? "rest_handler_cpu_delay" : "rest_handler_stream",
    samples: samples.length,
    bytes,
    originalBytes,
    gzipFrames: 0,
    duplicateChunks,
    chunksLost,
    orderOk,
    ...measure(samples),
  };
};

export const runSocketBridgeBench = async (options?: {
  readonly warmup?: number;
  readonly iterations?: number;
  readonly streamChunks?: number;
  readonly repeats?: number;
}): Promise<SocketBridgeBenchReport> => {
  const warmup = options?.warmup ?? 2;
  const iterations = options?.iterations ?? 8;
  const streamChunks = options?.streamChunks ?? 8;
  const repeats = options?.repeats ?? 5;
  sampleHeapEnabled = false;
  await runUnary(warmup, false);
  await runUnary(warmup, true);
  await runStream(warmup, streamChunks, false);
  await runStream(Math.max(2, Math.floor(warmup / 8)), streamChunks, true);
  await runLoopbackRelayBench(2, streamChunks, false);
  await runLoopbackRelayBench(2, streamChunks, true);
  global.gc?.();
  measuredHeapBaselineBytes = process.memoryUsage().heapUsed;
  observedHeapPeakBytes = measuredHeapBaselineBytes;
  sampleHeapEnabled = true;
  const scenarios = [
    await repeatMeasured(repeats, () => runUnary(iterations, false)),
    await repeatMeasured(repeats, () => runUnary(iterations, true)),
    await repeatMeasured(repeats, () => runStream(iterations, streamChunks, false)),
    await repeatMeasured(repeats, () =>
      runStream(Math.max(2, Math.floor(iterations / 8)), streamChunks, true),
    ),
    await repeatMeasured(repeats, () =>
      runLoopbackRelayBench(Math.max(2, Math.floor(iterations / 32)), streamChunks, false),
    ),
    await repeatMeasured(repeats, () =>
      runLoopbackRelayBench(Math.max(2, Math.floor(iterations / 32)), streamChunks, true),
    ),
  ];
  resetBenchState();
  return {
    harnessVersion: 3,
    // Hash only runtime numeric/boolean settings; never include URLs, signing keys or credentials.
    configFingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(env)
            .filter(
              ([key, value]) =>
                /^(socket|payloadFrame)/.test(key) &&
                !key.startsWith("socketConsumerPreparation") &&
                (typeof value === "number" || typeof value === "boolean"),
            )
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      )
      .digest("hex"),
    nodeVersion: process.version,
    platform: process.platform,
    config: { warmup, iterations, streamChunks, repeats },
    env: {
      nodeEnv: process.env.NODE_ENV ?? "",
      inboundGuardMode: process.env.SOCKET_AGENT_INBOUND_GUARD_MODE ?? "observe",
      outboundMaxPendingBytes: process.env.SOCKET_RELAY_OUTBOUND_MAX_PENDING_BYTES ?? "0",
    },
    heapUsedPeakBytes: observedHeapPeakBytes,
    heapUsedGrowthPeakBytes: Math.max(0, observedHeapPeakBytes - measuredHeapBaselineBytes),
    scenarios,
  };
};

/**
 * Process-level scheduling and GC noise can dominate sub-millisecond samples.
 * Keep correctness strict across every run, but gate resource metrics on their
 * median so one interrupted run cannot fail an otherwise healthy build.
 */
export const runStableSocketBridgeBench = async (
  options: Parameters<typeof runSocketBridgeBench>[0],
  runCount = 3,
): Promise<SocketBridgeBenchReport> => {
  if (!Number.isInteger(runCount) || runCount < 1 || runCount % 2 === 0) {
    throw new Error("Socket bridge bench runCount must be a positive odd integer");
  }
  const reports: SocketBridgeBenchReport[] = [];
  for (let index = 0; index < runCount; index += 1) {
    reports.push(await runSocketBridgeBench(options));
  }
  const first = reports[0];
  if (!first) {
    throw new Error("Socket bridge bench produced no reports");
  }
  return {
    ...first,
    heapUsedPeakBytes: median(reports.map((report) => report.heapUsedPeakBytes)),
    heapUsedGrowthPeakBytes: median(reports.map((report) => report.heapUsedGrowthPeakBytes)),
    scenarios: first.scenarios.map((scenario, scenarioIndex) =>
      medianScenario(
        reports.map((report) => {
          const matching = report.scenarios[scenarioIndex];
          if (!matching || matching.name !== scenario.name) {
            throw new Error(`Socket bridge bench scenario mismatch: ${scenario.name}`);
          }
          return matching;
        }),
      ),
    ),
  };
};
