import { afterEach, describe, expect, it } from "vitest";

import {
  getClientAgentAccessPublicDecisionMetricsSnapshot,
  recordClientAgentAccessPublicDecisionFinished,
  recordClientAgentAccessPublicDecisionStarted,
  resetClientAgentAccessPublicDecisionMetricsForTests,
} from "../../../../src/shared/metrics/client_agent_access_public_decision.metrics";

describe("client_agent_access_public_decision metrics", () => {
  afterEach(() => {
    resetClientAgentAccessPublicDecisionMetricsForTests();
  });

  it("tracks approve outcomes and latency summaries", () => {
    recordClientAgentAccessPublicDecisionStarted("approve");
    recordClientAgentAccessPublicDecisionFinished({
      decision: "approve",
      outcome: "approved",
      durationMs: 12,
    });
    recordClientAgentAccessPublicDecisionFinished({
      decision: "approve",
      outcome: "service_unavailable",
      durationMs: 30,
    });

    const snapshot = getClientAgentAccessPublicDecisionMetricsSnapshot();

    expect(snapshot.approve.startedTotal).toBe(1);
    expect(snapshot.approve.outcomes.approved).toBe(1);
    expect(snapshot.approve.outcomes.service_unavailable).toBe(1);
    expect(snapshot.approve.latencyCount).toBe(2);
    expect(snapshot.approve.latencySumMs).toBe(42);
    expect(snapshot.approve.latencyMaxMs).toBe(30);
    expect(snapshot.approve.latencyAvgMs).toBe(21);
  });

  it("tracks reject outcomes independently", () => {
    recordClientAgentAccessPublicDecisionStarted("reject");
    recordClientAgentAccessPublicDecisionFinished({
      decision: "reject",
      outcome: "rejected",
      durationMs: 8,
    });
    recordClientAgentAccessPublicDecisionFinished({
      decision: "reject",
      outcome: "expired",
      durationMs: 10,
    });

    const snapshot = getClientAgentAccessPublicDecisionMetricsSnapshot();

    expect(snapshot.reject.startedTotal).toBe(1);
    expect(snapshot.reject.outcomes.rejected).toBe(1);
    expect(snapshot.reject.outcomes.expired).toBe(1);
    expect(snapshot.reject.latencyCount).toBe(2);
    expect(snapshot.reject.latencyAvgMs).toBe(9);
    expect(snapshot.approve.startedTotal).toBe(0);
  });
});
