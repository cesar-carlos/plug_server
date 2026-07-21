import { afterEach, describe, expect, it } from "vitest";

import {
  buildRelayHubMetricsSnapshot,
  ensureAgentCircuitClosed,
  noteBridgeAckRetryAttempt,
  noteBridgeAckRetryExhausted,
  registerAgentFailure,
  relayMetrics,
  resetRelayHubHealthAndMetrics,
} from "../../../../../src/presentation/socket/hub/relay/bridge_relay_health_metrics";
import { env } from "../../../../../src/shared/config/env";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRestPendingRequestsStore } from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetRelayStreamFlowState } from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(() => {
  resetRelayHubHealthAndMetrics();
  resetRelayRequestRegistry();
  resetRestPendingRequestsStore();
  resetRelayStreamFlowState();
});

describe("bridge_relay_health_metrics", () => {
  it("buildRelayHubMetricsSnapshot passes through activeStreams and aggregates counters", () => {
    relayMetrics.requestsAccepted = 2;
    const snap = buildRelayHubMetricsSnapshot({
      activeStreams: 7,
      restMaterializeStreamsInFlight: 0,
    });
    expect(snap.counters.requestsAccepted).toBe(2);
    expect(snap.gauges.activeStreams).toBe(7);
    expect(snap.gauges.restMaterializeStreamsInFlight).toBe(0);
    expect(snap.gauges.pendingRelayRequests).toBe(0);
    expect(typeof snap.restAgentDispatchQueue.totalInflight).toBe("number");
  });

  it("resetRelayHubHealthAndMetrics clears relayMetrics fields", () => {
    relayMetrics.chunksDropped = 9;
    registerAgentFailure("agent-x", "relay");
    resetRelayHubHealthAndMetrics();
    expect(relayMetrics.chunksDropped).toBe(0);
    const snap = buildRelayHubMetricsSnapshot({
      activeStreams: 0,
      restMaterializeStreamsInFlight: 0,
    });
    expect(snap.gauges.openCircuits).toBe(0);
  });

  it("tracks ACK retry metrics by bridge path and aggregate", () => {
    noteBridgeAckRetryAttempt("rest");
    noteBridgeAckRetryAttempt("relay");
    noteBridgeAckRetryExhausted("relay");

    const snap = buildRelayHubMetricsSnapshot({
      activeStreams: 0,
      restMaterializeStreamsInFlight: 0,
    });

    expect(snap.counters.ackRetryAttempts).toBe(2);
    expect(snap.counters.ackRetryAttemptsByPath).toEqual({ rest: 1, relay: 1 });
    expect(snap.counters.ackRetryExhausted).toBe(1);
    expect(snap.counters.ackRetryExhaustedByPath).toEqual({ rest: 0, relay: 1 });

    resetRelayHubHealthAndMetrics();
    expect(relayMetrics.ackRetryAttemptsByPath).toEqual({ rest: 0, relay: 0 });
    expect(relayMetrics.ackRetryExhaustedByPath).toEqual({ rest: 0, relay: 0 });
  });

  it("isolates circuit open state between rest and relay channels", () => {
    const threshold = Math.max(1, env.socketRelayCircuitFailureThreshold);
    for (let i = 0; i < threshold; i += 1) {
      registerAgentFailure("agent-iso", "relay");
    }
    expect(() => ensureAgentCircuitClosed("agent-iso", "relay")).toThrow(/circuit is open/);
    expect(() => ensureAgentCircuitClosed("agent-iso", "rest")).not.toThrow();
  });
});
