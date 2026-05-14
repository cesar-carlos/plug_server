import { percentile } from "../../shared/utils/percentile";

const latencySamplesMax = 256;
const latencyHistogramBucketsMs = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 30_000,
] as const;

export type BridgeRpcMethodMetricChannel = "rest" | "consumer_socket" | "relay" | "unknown";
export type BridgeRpcMethodMetricOutcome =
  | "success"
  | "notification"
  | "error"
  | "timeout"
  | "abort";

interface BridgeRpcMethodMetricState {
  count: number;
  latencyTotalMs: number;
  latencyMaxMs: number;
  latencySamples: number[];
  latencyBucketCounts: number[];
}

export interface BridgeRpcMethodMetricSnapshot {
  readonly channel: BridgeRpcMethodMetricChannel;
  readonly method: string;
  readonly outcome: BridgeRpcMethodMetricOutcome;
  readonly count: number;
  readonly latencyAvgMs: number;
  readonly latencyMaxMs: number;
  readonly latencyP95Ms: number;
  readonly latencyP99Ms: number;
  readonly latencySumMs: number;
  readonly latencyBuckets: readonly {
    readonly le: string;
    readonly count: number;
  }[];
}

const states = new Map<string, BridgeRpcMethodMetricState>();

const normalizeMethodLabel = (method: string): string => {
  const trimmed = method.trim();
  if (trimmed === "") {
    return "unknown";
  }
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
};

const keyOf = (
  channel: BridgeRpcMethodMetricChannel,
  method: string,
  outcome: BridgeRpcMethodMetricOutcome,
): string => `${channel}\u0000${normalizeMethodLabel(method)}\u0000${outcome}`;

const getOrCreateState = (key: string): BridgeRpcMethodMetricState => {
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const created: BridgeRpcMethodMetricState = {
    count: 0,
    latencyTotalMs: 0,
    latencyMaxMs: 0,
    latencySamples: [],
    latencyBucketCounts: latencyHistogramBucketsMs.map(() => 0),
  };
  states.set(key, created);
  return created;
};

export const observeBridgeRpcMethod = (input: {
  readonly channel: BridgeRpcMethodMetricChannel;
  readonly method: string;
  readonly outcome: BridgeRpcMethodMetricOutcome;
  readonly elapsedMs: number;
}): void => {
  const safeMs = Math.max(0, input.elapsedMs);
  const state = getOrCreateState(keyOf(input.channel, input.method, input.outcome));
  state.count += 1;
  state.latencyTotalMs += safeMs;
  state.latencyMaxMs = Math.max(state.latencyMaxMs, safeMs);
  latencyHistogramBucketsMs.forEach((bucket, index) => {
    if (safeMs <= bucket) {
      state.latencyBucketCounts[index] = (state.latencyBucketCounts[index] ?? 0) + 1;
    }
  });
  state.latencySamples.push(safeMs);
  if (state.latencySamples.length > latencySamplesMax) {
    state.latencySamples.shift();
  }
};

export const getBridgeRpcMethodMetricsSnapshot = (): BridgeRpcMethodMetricSnapshot[] =>
  Array.from(states.entries())
    .map(([key, state]) => {
      const [channel, method, outcome] = key.split("\u0000") as [
        BridgeRpcMethodMetricChannel,
        string,
        BridgeRpcMethodMetricOutcome,
      ];
      return {
        channel,
        method,
        outcome,
        count: state.count,
        latencyAvgMs:
          state.count > 0 ? Number((state.latencyTotalMs / state.count).toFixed(2)) : 0,
        latencyMaxMs: Number(state.latencyMaxMs.toFixed(2)),
        latencyP95Ms: Number(percentile(state.latencySamples, 95).toFixed(2)),
        latencyP99Ms: Number(percentile(state.latencySamples, 99).toFixed(2)),
        latencySumMs: Number(state.latencyTotalMs.toFixed(2)),
        latencyBuckets: [
          ...latencyHistogramBucketsMs.map((bucket, index) => ({
            le: String(bucket),
            count: state.latencyBucketCounts[index] ?? 0,
          })),
          { le: "+Inf", count: state.count },
        ],
      };
    })
    .sort((a, b) => {
      const left = `${a.channel}:${a.method}:${a.outcome}`;
      const right = `${b.channel}:${b.method}:${b.outcome}`;
      return left.localeCompare(right);
    });

export const resetBridgeRpcMethodMetrics = (): void => {
  states.clear();
};
