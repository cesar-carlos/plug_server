import { describe, expect, it } from "vitest";

import {
  getRestHttpRateLimitMetricsSnapshot,
  incrementRestHttpTokenRefreshRateLimitRejected,
  resetRestHttpRateLimitMetrics,
} from "../../../../src/application/services/rest_http_rate_limit_metrics.service";

describe("rest_http_rate_limit_metrics (token refresh)", () => {
  it("tracks token refresh rate-limit rejections independently", () => {
    resetRestHttpRateLimitMetrics();
    incrementRestHttpTokenRefreshRateLimitRejected();
    incrementRestHttpTokenRefreshRateLimitRejected();
    const snap = getRestHttpRateLimitMetricsSnapshot();
    expect(snap.tokenRefreshRejectedTotal).toBe(2);
    expect(snap.credentialAuthRejectedTotal).toBe(0);
  });
});
