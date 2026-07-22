import { afterEach, describe, expect, it } from "vitest";

import {
  clearAgentHealthPiggybackState,
  maybeRecordAgentHealthPiggyback,
  shouldSkipScheduledAgentHealthPoll,
} from "../../../../src/application/services/agent_health_piggyback.service";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../src/shared/metrics/socket_agent.metrics";

describe("agent_health_piggyback.service", () => {
  afterEach(() => {
    clearAgentHealthPiggybackState();
    resetSocketAgentMetrics();
  });

  const negotiatedCapabilities = {
    extensions: {
      healthPiggyback: {
        intervalRequests: 50,
        freshnessThresholdMs: 5000,
      },
    },
  };

  it("records a fresh piggyback snapshot and allows skipping the next poll", () => {
    const capturedAtMs = Date.now();
    const recorded = maybeRecordAgentHealthPiggyback({
      agentId: "agent-1",
      agentCapabilities: negotiatedCapabilities,
      rpcBody: {
        jsonrpc: "2.0",
        id: "req-1",
        result: { ok: true },
        meta: {
          health_snapshot: {
            captured_at_ms: capturedAtMs,
            freshness_threshold_ms: 5000,
            status: "healthy",
            sql_queue_pressure: 0.42,
            active_streams: 1,
            circuit_state: "closed",
          },
        },
      },
      nowMs: capturedAtMs + 100,
    });

    expect(recorded).toBe(true);
    expect(shouldSkipScheduledAgentHealthPoll("agent-1", capturedAtMs + 100)).toBe(true);
    expect(getSocketAgentMetricsSnapshot().agentHealth.piggybackUsedTotal).toBe(1);
    expect(getSocketAgentMetricsSnapshot().agentHealth.pollTotal).toBe(0);
  });

  it("ignores stale snapshots", () => {
    const capturedAtMs = Date.now() - 10_000;
    const recorded = maybeRecordAgentHealthPiggyback({
      agentId: "agent-1",
      agentCapabilities: negotiatedCapabilities,
      rpcBody: {
        meta: {
          health_snapshot: {
            captured_at_ms: capturedAtMs,
            freshness_threshold_ms: 5000,
            status: "healthy",
          },
        },
      },
    });

    expect(recorded).toBe(false);
    expect(shouldSkipScheduledAgentHealthPoll("agent-1")).toBe(false);
    expect(getSocketAgentMetricsSnapshot().agentHealth.piggybackUsedTotal).toBe(0);
  });

  it("ignores piggyback when extension is not negotiated", () => {
    const recorded = maybeRecordAgentHealthPiggyback({
      agentId: "agent-1",
      agentCapabilities: { extensions: {} },
      rpcBody: {
        meta: {
          health_snapshot: {
            captured_at_ms: Date.now(),
            freshness_threshold_ms: 5000,
            status: "healthy",
          },
        },
      },
    });

    expect(recorded).toBe(false);
  });

  it("records piggyback using negotiatedFreshnessThresholdMs without capabilities lookup", () => {
    const capturedAtMs = Date.now();
    const recorded = maybeRecordAgentHealthPiggyback({
      agentId: "agent-cached-threshold",
      negotiatedFreshnessThresholdMs: 5000,
      rpcBody: {
        meta: {
          health_snapshot: {
            captured_at_ms: capturedAtMs,
            status: "healthy",
          },
        },
      },
      nowMs: capturedAtMs + 100,
    });

    expect(recorded).toBe(true);
    expect(shouldSkipScheduledAgentHealthPoll("agent-cached-threshold", capturedAtMs + 100)).toBe(
      true,
    );
  });
});
