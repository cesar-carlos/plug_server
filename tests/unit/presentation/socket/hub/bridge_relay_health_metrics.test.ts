import { afterEach, describe, expect, it } from "vitest";

import {
  buildRelayHubMetricsSnapshot,
  registerAgentFailure,
  relayMetrics,
  resetRelayHubHealthAndMetrics,
} from "../../../../../src/presentation/socket/hub/bridge_relay_health_metrics";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/relay_request_registry";
import { resetRestPendingRequestsStore } from "../../../../../src/presentation/socket/hub/rest_pending_requests";
import { resetRelayStreamFlowState } from "../../../../../src/presentation/socket/hub/relay_stream_flow_state";

afterEach(() => {
  resetRelayHubHealthAndMetrics();
  resetRelayRequestRegistry();
  resetRestPendingRequestsStore();
  resetRelayStreamFlowState();
});

describe("bridge_relay_health_metrics", () => {
  it("buildRelayHubMetricsSnapshot passes through activeStreams and aggregates counters", () => {
    relayMetrics.requestsAccepted = 2;
    const snap = buildRelayHubMetricsSnapshot({ activeStreams: 7 });
    expect(snap.counters.requestsAccepted).toBe(2);
    expect(snap.gauges.activeStreams).toBe(7);
    expect(snap.gauges.pendingRelayRequests).toBe(0);
  });

  it("resetRelayHubHealthAndMetrics clears relayMetrics fields", () => {
    relayMetrics.chunksDropped = 9;
    registerAgentFailure("agent-x");
    resetRelayHubHealthAndMetrics();
    expect(relayMetrics.chunksDropped).toBe(0);
    const snap = buildRelayHubMetricsSnapshot({ activeStreams: 0 });
    expect(snap.gauges.openCircuits).toBe(0);
  });
});
