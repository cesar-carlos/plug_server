import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forwardRelayRouteResponse } from "../../../../../src/presentation/socket/hub/relay/relay_route_response_forwarder";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import {
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetRelayHubHealthAndMetrics } from "../../../../../src/presentation/socket/hub/relay/bridge_relay_health_metrics";
import { resetRelayOutboundQueueTails } from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";
import * as relayOutboundQueue from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";
import {
  getSocketConsumerMetricsSnapshot,
  resetSocketConsumerMetrics,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";
import { snapshotRelayRouteTransportFlags } from "../../../../../src/shared/constants/transport_extension_negotiation";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  type DecodedPayloadFrame,
} from "../../../../../src/shared/utils/payload_frame";

const AGENT_SOCKET_ID = "agent-forwarder-1";
const AGENT_ID = "agent-forwarder-1";
const CONSUMER_SOCKET_ID = "consumer-forwarder-1";
const CONVERSATION_ID = "conversation-forwarder-1";
const REQUEST_ID = "hub-request-forwarder-1";
const CLIENT_REQUEST_ID = "client-request-forwarder-1";

const buildDecodedResponse = (
  body: Record<string, unknown>,
  requestId = REQUEST_ID,
): DecodedPayloadFrame => {
  const encoded = encodePayloadFrame(body, { requestId });
  const decoded = decodePayloadFrame(encoded);
  if (!decoded.ok) {
    throw new Error("failed to build decoded response fixture");
  }
  return decoded.value;
};

describe("forwardRelayRouteResponse", () => {
  beforeEach(() => {
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayHubHealthAndMetrics();
    resetSocketConsumerMetrics();
    resetRelayOutboundQueueTails();
    agentRegistry.clear();
  });

  afterEach(() => {
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayHubHealthAndMetrics();
    resetSocketConsumerMetrics();
    resetRelayOutboundQueueTails();
    agentRegistry.clear();
    vi.restoreAllMocks();
  });

  const registerAgent = (extensions: Record<string, unknown> = {}): void => {
    agentRegistry.registerAgentSession({
      agentId: AGENT_ID,
      socketId: AGENT_SOCKET_ID,
      userId: "user-forwarder-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
        extensions,
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    agentRegistry.touch(AGENT_ID, {
      markProtocolReady: true,
      socketId: AGENT_SOCKET_ID,
    });
  };

  const registerRoute = (
    overrides: Partial<Parameters<typeof registerRelayRequestRoute>[0]> = {},
  ): void => {
    const agentCapabilities = agentRegistry.getCapabilitiesByAgentId(AGENT_ID);
    const transportFlags = snapshotRelayRouteTransportFlags(agentCapabilities);
    registerRelayRequestRoute({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      consumerSocketId: CONSUMER_SOCKET_ID,
      agentSocketId: AGENT_SOCKET_ID,
      agentId: AGENT_ID,
      timeoutHandle: setTimeout(() => undefined, 60_000),
      createdAtMs: Date.now(),
      clientRequestId: CLIENT_REQUEST_ID,
      jsonRpcMethod: "sql.execute",
      ...transportFlags,
      ...overrides,
    });
  };

  it("should increment late-response metric and skip emit when route already timed out", () => {
    registerAgent({ clientRequestIdEcho: "v1" });
    registerRoute({ timedOut: true });

    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: CLIENT_REQUEST_ID,
      result: { rows: [], row_count: 0 },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    expect(emitToConsumer).not.toHaveBeenCalled();
    expect(getSocketConsumerMetricsSnapshot().relayOptIns.lateResponseAfterTimeoutTotal).toBe(1);
  });

  it("should emit synthetic error frame and metric when outbound encode fails", async () => {
    registerAgent();
    registerRoute();

    const encodeSpy = vi.spyOn(relayOutboundQueue, "encodeRelayOutboundFrame");
    encodeSpy.mockRejectedValueOnce(new Error("encode failed"));

    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: REQUEST_ID,
      result: { rows: [], row_count: 0 },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));

    const [consumerSocketId, eventName, framePayload] = emitToConsumer.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(consumerSocketId).toBe(CONSUMER_SOCKET_ID);
    expect(eventName).toBe(socketEvents.relayRpcResponse);

    const consumerDecoded = decodePayloadFrame(framePayload);
    expect(consumerDecoded.ok).toBe(true);
    if (consumerDecoded.ok) {
      const body = consumerDecoded.value.data as Record<string, unknown>;
      expect(body.id).toBe(CLIENT_REQUEST_ID);
      expect(body.error).toBeDefined();
      const error = body.error as Record<string, unknown>;
      const data = error.data as Record<string, unknown>;
      expect(data.code).toBe("BRIDGE_OUTBOUND_PROCESSING_FAILED");
    }

    expect(
      getSocketConsumerMetricsSnapshot().relayOptIns.relayOutboundJobFailureNotifiedTotal,
    ).toBe(1);
  });

  it("should not increment outbound failure metric when synthetic error encode also fails", async () => {
    registerAgent();
    registerRoute();

    const encodeSpy = vi.spyOn(relayOutboundQueue, "encodeRelayOutboundFrame");
    encodeSpy.mockRejectedValue(new Error("encode failed"));

    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: REQUEST_ID,
      result: { rows: [], row_count: 0 },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(encodeSpy).toHaveBeenCalledTimes(2));

    expect(emitToConsumer).not.toHaveBeenCalled();
    expect(
      getSocketConsumerMetricsSnapshot().relayOptIns.relayOutboundJobFailureNotifiedTotal,
    ).toBe(0);
  });

  it("should strip meta.agent_phases when agentPhaseTimings is not negotiated", async () => {
    registerAgent({ clientRequestIdEcho: "v1" });
    registerRoute();

    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: CLIENT_REQUEST_ID,
      result: { rows: [], row_count: 0 },
      meta: {
        agent_phases: { dispatch_ms: 12 },
      },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));

    const [, , framePayload] = emitToConsumer.mock.calls[0] as [string, string, unknown];
    const consumerDecoded = decodePayloadFrame(framePayload);
    expect(consumerDecoded.ok).toBe(true);
    if (consumerDecoded.ok) {
      const body = consumerDecoded.value.data as Record<string, unknown>;
      const meta = body.meta as Record<string, unknown> | undefined;
      expect(meta?.agent_phases).toBeUndefined();
    }
  });

  it("should strip meta.agent_phases when agentPhaseTimings is negotiated but requestServerTimings is off", async () => {
    registerAgent({
      clientRequestIdEcho: "v1",
      agentPhaseTimings: "v1",
    });
    registerRoute();

    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: CLIENT_REQUEST_ID,
      result: { rows: [], row_count: 0 },
      meta: {
        agent_phases: { dispatch_ms: 12 },
      },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));

    const [, , framePayload] = emitToConsumer.mock.calls[0] as [string, string, unknown];
    const consumerDecoded = decodePayloadFrame(framePayload);
    expect(consumerDecoded.ok).toBe(true);
    if (consumerDecoded.ok) {
      const body = consumerDecoded.value.data as Record<string, unknown>;
      const meta = body.meta as Record<string, unknown> | undefined;
      expect(meta?.agent_phases).toBeUndefined();
    }
  });

  it("should preserve meta.agent_phases when agentPhaseTimings is negotiated and requestServerTimings is true", async () => {
    registerAgent({
      clientRequestIdEcho: "v1",
      agentPhaseTimings: "v1",
    });
    registerRoute({ requestServerTimings: true });

    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: CLIENT_REQUEST_ID,
      result: { rows: [], row_count: 0 },
      meta: {
        agent_phases: { dispatch_ms: 12 },
      },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));

    const [, , framePayload] = emitToConsumer.mock.calls[0] as [string, string, unknown];
    const consumerDecoded = decodePayloadFrame(framePayload);
    expect(consumerDecoded.ok).toBe(true);
    if (consumerDecoded.ok) {
      const body = consumerDecoded.value.data as Record<string, unknown>;
      const meta = body.meta as Record<string, unknown>;
      expect(meta.agent_phases).toEqual({ dispatch_ms: 12 });
    }
  });

  it("should use route-cached agentPhaseTimingsNegotiated without agent registry lookup", async () => {
    registerAgent({
      clientRequestIdEcho: "v1",
      agentPhaseTimings: "v1",
    });
    registerRoute({
      agentPhaseTimingsNegotiated: false,
      healthPiggybackNegotiated: false,
    });

    const getCapsSpy = vi.spyOn(agentRegistry, "getCapabilitiesByAgentId");
    const emitToConsumer = vi.fn();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: CLIENT_REQUEST_ID,
      result: { rows: [], row_count: 0 },
      meta: {
        agent_phases: { dispatch_ms: 12 },
      },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
    expect(getCapsSpy).not.toHaveBeenCalled();

    const [, , framePayload] = emitToConsumer.mock.calls[0] as [string, string, unknown];
    const consumerDecoded = decodePayloadFrame(framePayload);
    expect(consumerDecoded.ok).toBe(true);
    if (consumerDecoded.ok) {
      const body = consumerDecoded.value.data as Record<string, unknown>;
      const meta = body.meta as Record<string, unknown> | undefined;
      expect(meta?.agent_phases).toBeUndefined();
    }
  });

  it("should record piggyback health using cached threshold without capabilities lookup", async () => {
    registerAgent({
      healthPiggyback: { intervalRequests: 50, freshnessThresholdMs: 5000 },
    });
    registerRoute({
      healthPiggybackNegotiated: true,
      jsonRpcMethod: "sql.execute",
    });

    const getCapsSpy = vi.spyOn(agentRegistry, "getCapabilitiesByAgentId");
    const getThresholdSpy = vi.spyOn(agentRegistry, "getHealthPiggybackFreshnessThresholdMs");
    const emitToConsumer = vi.fn();
    const capturedAtMs = Date.now();
    const decoded = buildDecodedResponse({
      jsonrpc: "2.0",
      id: CLIENT_REQUEST_ID,
      result: { rows: [], row_count: 0 },
      meta: {
        health_snapshot: {
          captured_at_ms: capturedAtMs,
          status: "healthy",
        },
      },
    });

    forwardRelayRouteResponse({
      socketId: AGENT_SOCKET_ID,
      candidateIds: [REQUEST_ID],
      decoded,
      streamId: null,
      inboundSyncStart: performance.now(),
      decodeMs: 1,
      emitToConsumer,
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
    expect(getThresholdSpy).toHaveBeenCalledWith(AGENT_ID);
    expect(getCapsSpy).not.toHaveBeenCalled();
  });
});
