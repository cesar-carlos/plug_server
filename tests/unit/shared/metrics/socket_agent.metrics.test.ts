import { describe, expect, it } from "vitest";

import {
  getSocketAgentMetricsSnapshot,
  noteAgentReadyInvalidPartialPayload,
  noteAgentReadyLegacyPayload,
  noteAgentCapabilityProfile,
  noteAgentHealthRpcResponse,
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

  it("classifies registered agent plug profiles and health capability", () => {
    resetSocketAgentMetrics();
    noteAgentCapabilityProfile({ extensions: { plugProfile: "plug-jsonrpc-profile/2.10" } });
    noteAgentCapabilityProfile({ extensions: { plugProfile: "plug-jsonrpc-profile/2.9" } });
    noteAgentCapabilityProfile({ extensions: { plugProfile: "unknown" } });

    const snap = getSocketAgentMetricsSnapshot();
    expect(snap.capabilityProfiles.current).toBe(1);
    expect(snap.capabilityProfiles.older).toBe(1);
    expect(snap.capabilityProfiles.unknown).toBe(1);
    expect(snap.capabilityAgentGetHealthCapableTotal).toBe(2);
  });

  it("records legacy agent:ready payloads", () => {
    resetSocketAgentMetrics();
    noteAgentReadyLegacyPayload();

    expect(getSocketAgentMetricsSnapshot().agentReadyLegacyPayloadTotal).toBe(1);

    resetSocketAgentMetrics();
    expect(getSocketAgentMetricsSnapshot().agentReadyLegacyPayloadTotal).toBe(0);
  });

  it("records invalid partial agent:ready payloads", () => {
    resetSocketAgentMetrics();
    noteAgentReadyInvalidPartialPayload();

    expect(getSocketAgentMetricsSnapshot().agentReadyInvalidPartialPayloadTotal).toBe(1);

    resetSocketAgentMetrics();
    expect(getSocketAgentMetricsSnapshot().agentReadyInvalidPartialPayloadTotal).toBe(0);
  });

  it("records agent.getHealth responses and errors", () => {
    resetSocketAgentMetrics();
    noteAgentHealthRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        status: "healthy",
        uptime_seconds: 123,
        sql_queue: {
          enabled: true,
          current_size: 4,
          max_size: 20,
          active_workers: 2,
          max_workers: 5,
          rejections_total: 6,
          timeouts_total: 7,
          avg_wait_time_ms: 8,
        },
        queries: {
          total: 100,
          errors: 3,
          success_rate: 97,
          avg_latency_ms: 12,
          p95_latency_ms: 18,
          p99_latency_ms: 42,
        },
      },
    });
    noteAgentHealthRpcResponse({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32_000, message: "failed" },
    });

    const snap = getSocketAgentMetricsSnapshot();
    expect(snap.agentHealth.responsesTotal).toBe(1);
    expect(snap.agentHealth.errorsTotal).toBe(1);
    expect(snap.agentHealth.lastSeenAtMs).toBeGreaterThan(0);
    expect(snap.agentHealth.lastHealthy).toBe(1);
    expect(snap.agentHealth.lastDegraded).toBe(0);
    expect(snap.agentHealth.lastUptimeSeconds).toBe(123);
    expect(snap.agentHealth.lastSqlQueueCurrentSize).toBe(4);
    expect(snap.agentHealth.lastSqlQueueMaxSize).toBe(20);
    expect(snap.agentHealth.lastActiveWorkers).toBe(2);
    expect(snap.agentHealth.lastMaxWorkers).toBe(5);
    expect(snap.agentHealth.lastSqlQueueRejectionsTotal).toBe(6);
    expect(snap.agentHealth.lastSqlQueueTimeoutsTotal).toBe(7);
    expect(snap.agentHealth.lastSqlQueueAvgWaitTimeMs).toBe(8);
    expect(snap.agentHealth.lastQueryTotal).toBe(100);
    expect(snap.agentHealth.lastQueryErrors).toBe(3);
    expect(snap.agentHealth.lastQuerySuccessRate).toBe(97);
    expect(snap.agentHealth.lastAvgLatencyMs).toBe(12);
    expect(snap.agentHealth.lastP95LatencyMs).toBe(18);
    expect(snap.agentHealth.lastP99LatencyMs).toBe(42);
  });
});
