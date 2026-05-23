import { afterEach, describe, expect, it, vi } from "vitest";

const mockSampleRate = vi.hoisted(() => ({ value: 1 }));

vi.mock("../../../../src/shared/config/env", () => ({
  env: {
    get socketMetricsSampleRate() {
      return mockSampleRate.value;
    },
  },
}));

import {
  sampledMetricDelta,
  shouldSampleMetric,
} from "../../../../src/shared/metrics/metrics_sample";

describe("metrics_sample", () => {
  afterEach(() => {
    mockSampleRate.value = 1;
    vi.restoreAllMocks();
  });

  it("shouldSampleMetric always returns true when rate is 1", () => {
    mockSampleRate.value = 1;
    expect(shouldSampleMetric()).toBe(true);
    expect(shouldSampleMetric()).toBe(true);
  });

  it("shouldSampleMetric always returns false when rate is 0", () => {
    mockSampleRate.value = 0;
    expect(shouldSampleMetric()).toBe(false);
  });

  it("shouldSampleMetric follows the configured probability", () => {
    mockSampleRate.value = 0.25;
    vi.spyOn(Math, "random").mockReturnValue(0.24);
    expect(shouldSampleMetric()).toBe(true);
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    expect(shouldSampleMetric()).toBe(false);
  });

  it("sampledMetricDelta returns the full delta when rate is 1", () => {
    mockSampleRate.value = 1;
    expect(sampledMetricDelta(5)).toBe(5);
    expect(sampledMetricDelta()).toBe(1);
  });

  it("sampledMetricDelta returns 0 when rate is 0", () => {
    mockSampleRate.value = 0;
    expect(sampledMetricDelta(3)).toBe(0);
  });

  it("sampledMetricDelta scales kept observations for unbiased totals", () => {
    mockSampleRate.value = 0.1;
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    expect(sampledMetricDelta(2)).toBe(20);
  });

  it("sampledMetricDelta returns 0 for non-positive deltas", () => {
    expect(sampledMetricDelta(0)).toBe(0);
    expect(sampledMetricDelta(-1)).toBe(0);
  });
});
