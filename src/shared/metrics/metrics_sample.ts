import { env } from "../config/env";

/** Whether this hot-path observation should contribute to sampled counters. */
export const shouldSampleMetric = (): boolean => {
  const rate = env.socketMetricsSampleRate;
  if (rate >= 1) {
    return true;
  }
  if (rate <= 0) {
    return false;
  }
  return Math.random() < rate;
};

/**
 * Returns an unbiased increment for sampled counters (`delta / rate` when kept).
 * Use on high-frequency relay/stream counters only; error and security counters stay exact.
 */
export const sampledMetricDelta = (delta = 1): number => {
  if (delta <= 0) {
    return 0;
  }
  const rate = env.socketMetricsSampleRate;
  if (rate >= 1) {
    return delta;
  }
  if (rate <= 0) {
    return 0;
  }
  if (!shouldSampleMetric()) {
    return 0;
  }
  return delta / rate;
};
