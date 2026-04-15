import { afterEach, describe, expect, it } from "vitest";

import {
  getClientMeAgentsMetricsSnapshot,
  recordClientMeAgentsDetailResponse,
  recordClientMeAgentsListResponse,
  resetClientMeAgentsMetricsForTests,
} from "../../../../src/shared/metrics/client_me_agents.metrics";

describe("client_me_agents metrics", () => {
  afterEach(() => {
    resetClientMeAgentsMetricsForTests();
  });

  it("accumulates list response counts and hub-connected totals", () => {
    recordClientMeAgentsListResponse(0);
    recordClientMeAgentsListResponse(2);
    const snap = getClientMeAgentsMetricsSnapshot();
    expect(snap.listResponsesTotal).toBe(2);
    expect(snap.listHubConnectedTrueTotal).toBe(2);
  });

  it("accumulates detail response and true count", () => {
    recordClientMeAgentsDetailResponse(false);
    recordClientMeAgentsDetailResponse(true);
    const snap = getClientMeAgentsMetricsSnapshot();
    expect(snap.detailResponsesTotal).toBe(2);
    expect(snap.detailHubConnectedTrueTotal).toBe(1);
  });
});
