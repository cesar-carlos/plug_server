import { afterEach, describe, expect, it, vi } from "vitest";

const mockSampleRate = vi.hoisted(() => ({ value: 1 }));

vi.mock("../../../../../src/shared/config/env", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const baseEnv = actual.env as Record<string, unknown>;
  return {
    ...actual,
    env: new Proxy(baseEnv, {
      get(target, prop, receiver) {
        if (prop === "socketMetricsSampleRate") {
          return mockSampleRate.value;
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

import {
  buildRelayHubMetricsSnapshot,
  ensureAgentCircuitClosed,
  noteBridgeAckRetryAttempt,
  noteBridgeAckRetryExhausted,
  observeRelayBridgeEncode,
  observeRelayFrameDecode,
  observeRelayOverloadCheck,
  registerAgentFailure,
  relayMetrics,
  resetRelayHubHealthAndMetrics,
} from "../../../../../src/presentation/socket/hub/relay/bridge_relay_health_metrics";
import { env } from "../../../../../src/shared/config/env";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRestPendingRequestsStore } from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetRelayStreamFlowState } from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(() => {
  mockSampleRate.value = 1;
  vi.restoreAllMocks();
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

  it("records hot-path observe metrics exactly when SOCKET_METRICS_SAMPLE_RATE is 1", () => {
    mockSampleRate.value = 1;
    observeRelayOverloadCheck(4);
    observeRelayFrameDecode(2);
    observeRelayBridgeEncode(3);

    expect(relayMetrics.overloadChecksTotal).toBe(1);
    expect(relayMetrics.overloadCheckSumMs).toBe(4);
    expect(relayMetrics.frameDecodeCount).toBe(1);
    expect(relayMetrics.frameDecodeSumMs).toBe(2);
    expect(relayMetrics.bridgeEncodeCount).toBe(1);
    expect(relayMetrics.bridgeEncodeSumMs).toBe(3);
  });

  it("scales hot-path observe metrics when SOCKET_METRICS_SAMPLE_RATE is below 1", () => {
    mockSampleRate.value = 0.1;
    vi.spyOn(Math, "random").mockReturnValue(0.05);

    observeRelayOverloadCheck(5);
    observeRelayFrameDecode(2);
    observeRelayBridgeEncode(3);

    expect(relayMetrics.overloadChecksTotal).toBe(10);
    expect(relayMetrics.overloadCheckSumMs).toBe(50);
    expect(relayMetrics.frameDecodeCount).toBe(10);
    expect(relayMetrics.frameDecodeSumMs).toBe(20);
    expect(relayMetrics.bridgeEncodeCount).toBe(10);
    expect(relayMetrics.bridgeEncodeSumMs).toBe(30);
  });

  it("skips hot-path observe metrics when SOCKET_METRICS_SAMPLE_RATE is 0", () => {
    mockSampleRate.value = 0;
    observeRelayOverloadCheck(5);
    observeRelayFrameDecode(2);
    observeRelayBridgeEncode(3);

    expect(relayMetrics.overloadChecksTotal).toBe(0);
    expect(relayMetrics.overloadCheckSumMs).toBe(0);
    expect(relayMetrics.frameDecodeCount).toBe(0);
    expect(relayMetrics.frameDecodeSumMs).toBe(0);
    expect(relayMetrics.bridgeEncodeCount).toBe(0);
    expect(relayMetrics.bridgeEncodeSumMs).toBe(0);
  });
});
