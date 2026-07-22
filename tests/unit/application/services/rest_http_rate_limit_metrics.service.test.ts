import { describe, expect, it } from "vitest";

import {
  getRestHttpRateLimitMetricsSnapshot,
  incrementRestHttpAgentsSelfProfileRateLimitRejected,
  incrementRestHttpClientMeAgentTokenPutRateLimitRejected,
  incrementRestHttpMeClientDecisionRateLimitRejected,
  incrementRestHttpClientPasswordRecoveryPollRateLimitRejected,
  incrementRestHttpClientPasswordRecoveryRequestRateLimitRejected,
  incrementRestHttpClientThumbnailRateLimitRejected,
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

  it("tracks route-specific limiter rejections that are not command/auth buckets", () => {
    resetRestHttpRateLimitMetrics();
    incrementRestHttpAgentsSelfProfileRateLimitRejected();
    incrementRestHttpClientThumbnailRateLimitRejected();
    incrementRestHttpClientThumbnailRateLimitRejected();
    incrementRestHttpClientPasswordRecoveryRequestRateLimitRejected();
    incrementRestHttpClientPasswordRecoveryPollRateLimitRejected();
    incrementRestHttpClientMeAgentTokenPutRateLimitRejected();
    incrementRestHttpMeClientDecisionRateLimitRejected();

    const snap = getRestHttpRateLimitMetricsSnapshot();
    expect(snap.agentsSelfProfileRejectedTotal).toBe(1);
    expect(snap.clientThumbnailRejectedTotal).toBe(2);
    expect(snap.clientPasswordRecoveryRequestRejectedTotal).toBe(1);
    expect(snap.clientPasswordRecoveryPollRejectedTotal).toBe(1);
    expect(snap.clientMeAgentTokenPutRejectedTotal).toBe(1);
    expect(snap.meClientDecisionRejectedTotal).toBe(1);

    resetRestHttpRateLimitMetrics();
    const reset = getRestHttpRateLimitMetricsSnapshot();
    expect(reset.agentsSelfProfileRejectedTotal).toBe(0);
    expect(reset.clientThumbnailRejectedTotal).toBe(0);
    expect(reset.clientMeAgentTokenPutRejectedTotal).toBe(0);
    expect(reset.meClientDecisionRejectedTotal).toBe(0);
    expect(reset.clientPasswordRecoveryRequestRejectedTotal).toBe(0);
    expect(reset.clientPasswordRecoveryPollRejectedTotal).toBe(0);
  });
});
