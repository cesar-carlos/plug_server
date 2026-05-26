/**
 * RED (Request count / Errors / Duration) metrics for HTTP endpoints,
 * exposed via `GET /metrics`. Built as Map<labelKey, value> so cardinality
 * stays bounded to the actual routes seen on this hub instance.
 *
 * Label key encoding: `${method}|${route}|${statusBucket}` where
 * `statusBucket` is "2xx" | "3xx" | "4xx" | "5xx" — keeps cardinality low and
 * still useful to spot regression in error rate per route.
 */

const BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface RouteHistogram {
  readonly bucketCounts: number[];
  count: number;
  sumSeconds: number;
}

const requestsTotal = new Map<string, number>();
const requestDurationByRoute = new Map<string, RouteHistogram>();
const inFlightByRoute = new Map<string, number>();

const statusBucket = (status: number): string => {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
};

const labelKey = (method: string, route: string, status: number): string =>
  `${method.toUpperCase()}|${route}|${statusBucket(status)}`;

const inFlightKey = (method: string, route: string): string => `${method.toUpperCase()}|${route}`;

const createHistogram = (): RouteHistogram => ({
  bucketCounts: BUCKETS_SECONDS.map(() => 0),
  count: 0,
  sumSeconds: 0,
});

const observeBucket = (histogram: RouteHistogram, durationSeconds: number): void => {
  histogram.count += 1;
  histogram.sumSeconds += durationSeconds;
  for (let i = 0; i < BUCKETS_SECONDS.length; i += 1) {
    if (durationSeconds <= (BUCKETS_SECONDS[i] as number)) {
      histogram.bucketCounts[i] = (histogram.bucketCounts[i] ?? 0) + 1;
    }
  }
};

export const recordHttpRequest = (input: {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationSeconds: number;
}): void => {
  const key = labelKey(input.method, input.route, input.status);
  requestsTotal.set(key, (requestsTotal.get(key) ?? 0) + 1);

  let histogram = requestDurationByRoute.get(key);
  if (histogram === undefined) {
    histogram = createHistogram();
    requestDurationByRoute.set(key, histogram);
  }
  observeBucket(histogram, input.durationSeconds);
};

export const incrementHttpInFlight = (method: string, route: string): void => {
  const key = inFlightKey(method, route);
  inFlightByRoute.set(key, (inFlightByRoute.get(key) ?? 0) + 1);
};

export const decrementHttpInFlight = (method: string, route: string): void => {
  const key = inFlightKey(method, route);
  const current = inFlightByRoute.get(key) ?? 0;
  const next = current - 1;
  if (next <= 0) {
    inFlightByRoute.delete(key);
  } else {
    inFlightByRoute.set(key, next);
  }
};

export interface HttpRedMetricsSample {
  readonly method: string;
  readonly route: string;
  readonly statusBucket: string;
  readonly value: number;
}

export interface HttpRedHistogramSample {
  readonly method: string;
  readonly route: string;
  readonly statusBucket: string;
  readonly buckets: ReadonlyArray<{ readonly le: number; readonly count: number }>;
  readonly count: number;
  readonly sumSeconds: number;
}

export interface HttpRedInFlightSample {
  readonly method: string;
  readonly route: string;
  readonly value: number;
}

export interface HttpRedMetricsSnapshot {
  readonly buckets: readonly number[];
  readonly requestsTotal: ReadonlyArray<HttpRedMetricsSample>;
  readonly requestDurationSeconds: ReadonlyArray<HttpRedHistogramSample>;
  readonly requestsInFlight: ReadonlyArray<HttpRedInFlightSample>;
}

const decodeKey = (key: string): { method: string; route: string; statusBucket: string } | null => {
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  return {
    method: parts[0] as string,
    route: parts[1] as string,
    statusBucket: parts[2] as string,
  };
};

const decodeInFlightKey = (key: string): { method: string; route: string } | null => {
  const parts = key.split("|");
  if (parts.length !== 2) return null;
  return { method: parts[0] as string, route: parts[1] as string };
};

export const getHttpRedMetricsSnapshot = (): HttpRedMetricsSnapshot => {
  const samples: HttpRedMetricsSample[] = [];
  for (const [key, value] of requestsTotal) {
    const decoded = decodeKey(key);
    if (decoded !== null) {
      samples.push({ ...decoded, value });
    }
  }

  const histograms: HttpRedHistogramSample[] = [];
  for (const [key, hist] of requestDurationByRoute) {
    const decoded = decodeKey(key);
    if (decoded !== null) {
      histograms.push({
        ...decoded,
        buckets: BUCKETS_SECONDS.map((le, i) => ({
          le,
          count: hist.bucketCounts[i] ?? 0,
        })),
        count: hist.count,
        sumSeconds: hist.sumSeconds,
      });
    }
  }

  const inFlight: HttpRedInFlightSample[] = [];
  for (const [key, value] of inFlightByRoute) {
    const decoded = decodeInFlightKey(key);
    if (decoded !== null) {
      inFlight.push({ ...decoded, value });
    }
  }

  return {
    buckets: BUCKETS_SECONDS,
    requestsTotal: samples,
    requestDurationSeconds: histograms,
    requestsInFlight: inFlight,
  };
};

export const resetHttpRedMetrics = (): void => {
  requestsTotal.clear();
  requestDurationByRoute.clear();
  inFlightByRoute.clear();
};
