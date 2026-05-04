import { describe, expect, it } from "vitest";

import {
  getSocketAgentMetricsSnapshot,
  noteAgentSocketAuthRejected,
  resetSocketAgentMetrics,
} from "../../../../src/shared/metrics/socket_agent.metrics";

describe("socket_agent.metrics", () => {
  it("increments and resets auth rejection counters", () => {
    resetSocketAgentMetrics();
    noteAgentSocketAuthRejected("invalid_token");
    noteAgentSocketAuthRejected("invalid_token");
    noteAgentSocketAuthRejected("missing_token");
    const snap = getSocketAgentMetricsSnapshot();
    expect(snap.authRejects.invalid_token).toBe(2);
    expect(snap.authRejects.missing_token).toBe(1);
    expect(snap.authRejects.role_denied).toBe(0);
    resetSocketAgentMetrics();
    expect(getSocketAgentMetricsSnapshot().authRejects.invalid_token).toBe(0);
  });
});
