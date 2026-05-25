import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import { createRpcBridgeAgentInboundHandlers } from "../../../../../src/presentation/socket/hub/rpc_bridge_agent_inbound";
import {
  getActiveStreamRouteByRequestId,
  resetActiveStreamRegistry,
  upsertActiveStreamRoute,
} from "../../../../../src/presentation/socket/hub/active_stream_registry";
import {
  getRelayRequestRoute,
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/relay_request_registry";
import {
  relayMetrics,
  resetRelayHubHealthAndMetrics,
} from "../../../../../src/presentation/socket/hub/bridge_relay_health_metrics";
import { env } from "../../../../../src/shared/config/env";
import {
  getRestPendingRequestByCorrelationId,
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/rest_pending_requests";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../../src/shared/metrics/socket_agent.metrics";
import {
  decodePayloadFrame,
  encodePayloadFrame,
} from "../../../../../src/shared/utils/payload_frame";

describe("rpc_bridge_agent_inbound", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  beforeEach(() => {
    resetRestPendingRequestsStore();
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayHubHealthAndMetrics();
    resetSocketAgentMetrics();
    vi.useRealTimers();
  });

  afterEach(() => {
    resetRestPendingRequestsStore();
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayHubHealthAndMetrics();
    resetSocketAgentMetrics();
    for (const handle of timeoutHandles.splice(0)) {
      clearTimeout(handle);
    }
    vi.useRealTimers();
  });

  const createTimeoutHandle = (): NodeJS.Timeout => {
    const handle = setTimeout(() => undefined, 60_000);
    timeoutHandles.push(handle);
    return handle;
  };

  it("createRpcBridgeAgentInboundHandlers returns all inbound handlers", () => {
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });
    expect(typeof h.handleAgentRpcResponse).toBe("function");
    expect(typeof h.handleAgentRpcChunk).toBe("function");
    expect(typeof h.handleAgentRpcComplete).toBe("function");
    expect(typeof h.handleAgentRpcAck).toBe("function");
    expect(typeof h.handleAgentBatchAck).toBe("function");
  });

  it("isolates relay batch acks per consumer and clears ack retry timers", async () => {
    const emitToConsumer = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });
    const ackRetryTimerA = createTimeoutHandle();
    const ackRetryTimerB = createTimeoutHandle();

    registerRelayRequestRoute({
      requestId: "req-relay-batch-a",
      conversationId: "conv-a",
      consumerSocketId: "consumer-a",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      acked: false,
      ackRetryTimer: ackRetryTimerA,
    });
    registerRelayRequestRoute({
      requestId: "req-relay-batch-b",
      conversationId: "conv-b",
      consumerSocketId: "consumer-b",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      acked: false,
      ackRetryTimer: ackRetryTimerB,
    });

    h.handleAgentBatchAck(
      "socket-test",
      encodePayloadFrame(
        {
          request_ids: ["req-relay-batch-a", "req-relay-batch-b"],
          received_at: "2026-05-25T13:00:00.000Z",
        },
        { requestId: "batch-ack-1" },
      ),
    );

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(2));

    const routeA = getRelayRequestRoute("req-relay-batch-a");
    const routeB = getRelayRequestRoute("req-relay-batch-b");
    expect(routeA?.acked).toBe(true);
    expect(routeA).not.toHaveProperty("ackRetryTimer");
    expect(routeB?.acked).toBe(true);
    expect(routeB).not.toHaveProperty("ackRetryTimer");

    const decodedByConsumer = new Map<string, unknown>();
    for (const [consumerSocketId, eventName, frame] of emitToConsumer.mock.calls as [
      string,
      string,
      unknown,
    ][]) {
      expect(eventName).toBe(socketEvents.relayRpcBatchAck);
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        decodedByConsumer.set(consumerSocketId, decoded.value.data);
      }
    }

    expect(decodedByConsumer.get("consumer-a")).toEqual({
      request_ids: ["req-relay-batch-a"],
      received_at: "2026-05-25T13:00:00.000Z",
    });
    expect(decodedByConsumer.get("consumer-b")).toEqual({
      request_ids: ["req-relay-batch-b"],
      received_at: "2026-05-25T13:00:00.000Z",
    });
  });

  it("coalesces relay batch acks for the same consumer without leaking other ids", async () => {
    const emitToConsumer = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-relay-same-a",
      conversationId: "conv-a",
      consumerSocketId: "consumer-same",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      acked: false,
      ackRetryTimer: createTimeoutHandle(),
    });
    registerRelayRequestRoute({
      requestId: "req-relay-same-b",
      conversationId: "conv-b",
      consumerSocketId: "consumer-same",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      acked: false,
      ackRetryTimer: createTimeoutHandle(),
    });
    registerRelayRequestRoute({
      requestId: "req-relay-other",
      conversationId: "conv-c",
      consumerSocketId: "consumer-other",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      acked: false,
      ackRetryTimer: createTimeoutHandle(),
    });

    h.handleAgentBatchAck(
      "socket-test",
      encodePayloadFrame({
        request_ids: ["req-relay-same-a", "req-relay-same-b", "req-relay-other"],
        received_at: "2026-05-25T13:10:00.000Z",
      }),
    );

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(2));

    const decodedByConsumer = new Map<string, unknown>();
    for (const [consumerSocketId, eventName, frame] of emitToConsumer.mock.calls as [
      string,
      string,
      unknown,
    ][]) {
      expect(eventName).toBe(socketEvents.relayRpcBatchAck);
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        decodedByConsumer.set(consumerSocketId, decoded.value.data);
      }
    }

    expect(decodedByConsumer.get("consumer-same")).toEqual({
      request_ids: ["req-relay-same-a", "req-relay-same-b"],
      received_at: "2026-05-25T13:10:00.000Z",
    });
    expect(decodedByConsumer.get("consumer-other")).toEqual({
      request_ids: ["req-relay-other"],
      received_at: "2026-05-25T13:10:00.000Z",
    });
    for (const requestId of ["req-relay-same-a", "req-relay-same-b", "req-relay-other"]) {
      const route = getRelayRequestRoute(requestId);
      expect(route?.acked).toBe(true);
      expect(route).not.toHaveProperty("ackRetryTimer");
    }
  });

  it("rejects relay batch rpc responses per consumer without leaking original payloads", async () => {
    const emitToConsumer = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-response-a",
      conversationId: "conv-a",
      consumerSocketId: "consumer-a",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      clientRequestId: "client-a",
    });
    registerRelayRequestRoute({
      requestId: "req-response-b",
      conversationId: "conv-b",
      consumerSocketId: "consumer-b",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      clientRequestId: "client-b",
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        [
          { jsonrpc: "2.0", id: "req-response-a", result: { secret: "a" } },
          { jsonrpc: "2.0", id: "req-response-b", result: { secret: "b" } },
        ],
        { requestId: "batch-response-1" },
      ),
    );

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(2));

    const decodedByConsumer = new Map<string, unknown>();
    for (const [consumerSocketId, eventName, frame] of emitToConsumer.mock.calls as [
      string,
      string,
      unknown,
    ][]) {
      expect(eventName).toBe(socketEvents.relayRpcResponse);
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(Array.isArray(decoded.value.data)).toBe(false);
        decodedByConsumer.set(consumerSocketId, decoded.value.data);
      }
    }

    expect(decodedByConsumer.get("consumer-a")).toEqual({
      jsonrpc: "2.0",
      id: "req-response-a",
      error: {
        code: -32009,
        message: "Relay does not support batch rpc:response",
        data: {
          code: "RELAY_BATCH_RESPONSE_UNSUPPORTED",
          retryable: false,
        },
      },
    });
    expect(decodedByConsumer.get("consumer-b")).toEqual({
      jsonrpc: "2.0",
      id: "req-response-b",
      error: {
        code: -32009,
        message: "Relay does not support batch rpc:response",
        data: {
          code: "RELAY_BATCH_RESPONSE_UNSUPPORTED",
          retryable: false,
        },
      },
    });
    expect(getRelayRequestRoute("req-response-a")).toBeUndefined();
    expect(getRelayRequestRoute("req-response-b")).toBeUndefined();
  });

  it("rejects relay batch rpc responses for the same consumer as isolated errors", async () => {
    const emitToConsumer = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    for (const requestId of ["req-response-same-a", "req-response-same-b"]) {
      registerRelayRequestRoute({
        requestId,
        conversationId: "conv-same",
        consumerSocketId: "consumer-same",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
      });
    }

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame([
        { jsonrpc: "2.0", id: "req-response-same-a", result: { secret: "a" } },
        { jsonrpc: "2.0", id: "req-response-same-b", result: { secret: "b" } },
      ]),
    );

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(2));

    const responseIds: string[] = [];
    for (const [consumerSocketId, eventName, frame] of emitToConsumer.mock.calls as [
      string,
      string,
      unknown,
    ][]) {
      expect(consumerSocketId).toBe("consumer-same");
      expect(eventName).toBe(socketEvents.relayRpcResponse);
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(Array.isArray(decoded.value.data)).toBe(false);
        const data = decoded.value.data as { id?: unknown; error?: { data?: { code?: string } } };
        expect(data.error?.data?.code).toBe("RELAY_BATCH_RESPONSE_UNSUPPORTED");
        if (typeof data.id === "string") {
          responseIds.push(data.id);
        }
      }
    }

    expect(responseIds.sort()).toEqual(["req-response-same-a", "req-response-same-b"]);
    expect(getRelayRequestRoute("req-response-same-a")).toBeUndefined();
    expect(getRelayRequestRoute("req-response-same-b")).toBeUndefined();
  });

  it("should invoke Socket.IO ack on rpc:response decode failure (delivery guarantee compat)", async () => {
    const ack = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });
    h.handleAgentRpcResponse("socket-test", "not-a-payload-frame", ack);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
  });

  it("should resolve a pending rest request and ack a valid rpc:response", async () => {
    const ack = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    registerRestPendingRequest({
      primaryRequestId: "req-1",
      correlationIds: ["req-1"],
      socketId: "socket-test",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve,
      reject,
      timeoutHandle: createTimeoutHandle(),
      acked: false,
    });

    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-1",
          result: { ok: true },
        },
        { requestId: "req-1" },
      ),
      ack,
    );

    await vi.waitFor(() => {
      expect(resolve).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: "req-1",
        result: { ok: true },
      });
    });
    expect(reject).not.toHaveBeenCalled();
    expect(getRestPendingRequestByCorrelationId("req-1")).toBeUndefined();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("should keep pending state when rpc:response has no candidate ids but still ack", async () => {
    const ack = vi.fn();
    const resolve = vi.fn();
    registerRestPendingRequest({
      primaryRequestId: "req-1",
      correlationIds: ["req-1"],
      socketId: "socket-test",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve,
      reject: vi.fn(),
      timeoutHandle: createTimeoutHandle(),
      acked: false,
    });

    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          result: { ok: true },
        },
        { requestId: "frame-only-id" },
      ),
      ack,
    );

    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    expect(resolve).not.toHaveBeenCalled();
    expect(getRestPendingRequestByCorrelationId("req-1")).toBeDefined();
  });

  it("should register an active stream route when rpc:response opens a stream", async () => {
    registerRestPendingRequest({
      primaryRequestId: "req-stream",
      correlationIds: ["req-stream"],
      socketId: "socket-test",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve: vi.fn(),
      reject: vi.fn(),
      timeoutHandle: createTimeoutHandle(),
      acked: false,
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
    });

    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-stream",
          result: { stream_id: "stream-1" },
        },
        { requestId: "req-stream" },
      ),
    );

    await vi.waitFor(() => {
      expect(getActiveStreamRouteByRequestId("req-stream")).toMatchObject({
        requestId: "req-stream",
        agentSocketId: "socket-test",
        consumerSocketId: "consumer-1",
        streamId: "stream-1",
      });
    });
  });

  it("should fail fast and emit terminal error on invalid rpc:chunk frame for a legacy stream", async () => {
    const onComplete = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRestPendingRequest({
      primaryRequestId: "req-chunk",
      correlationIds: ["req-chunk"],
      socketId: "socket-test",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve: vi.fn(),
      reject: vi.fn(),
      timeoutHandle: createTimeoutHandle(),
      acked: false,
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete,
      },
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-chunk",
          result: { stream_id: "stream-legacy-1" },
        },
        { requestId: "req-chunk" },
      ),
    );

    await vi.waitFor(() => expect(getActiveStreamRouteByRequestId("req-chunk")).toBeDefined());

    const invalidChunkFrame = {
      ...encodePayloadFrame(
        {
          request_id: "req-chunk",
          stream_id: "stream-legacy-1",
          rows: [{ id: 1 }],
        },
        { requestId: "req-chunk" },
      ),
      originalSize: 1,
    };

    h.handleAgentRpcChunk("socket-test", invalidChunkFrame);

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        request_id: "req-chunk",
        total_rows: 0,
        terminal_status: "error",
        stream_id: "stream-legacy-1",
      });
    });
    expect(getActiveStreamRouteByRequestId("req-chunk")).toBeUndefined();
  });

  it("should synthesize compression_failed for relay rpc:response gunzip failures", async () => {
    const emitToConsumer = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-relay-compression",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    h.handleAgentRpcResponse("socket-test", {
      schemaVersion: "1.0",
      enc: "json",
      cmp: "gzip",
      contentType: "application/json",
      originalSize: 32,
      compressedSize: 3,
      payload: [1, 2, 3],
      requestId: "req-relay-compression",
    });

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
    const [consumerSocketId, eventName, outboundFrame] = emitToConsumer.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(consumerSocketId).toBe("consumer-1");
    expect(eventName).toBe(socketEvents.relayRpcResponse);

    const decoded = decodePayloadFrame(outboundFrame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.data).toMatchObject({
      jsonrpc: "2.0",
      id: "req-relay-compression",
      error: {
        code: -32011,
        message: "Compression failed",
        data: {
          reason: "compression_failed",
        },
      },
    });
  });

  it("records agent.getHealth metrics for relay responses", async () => {
    const emitToConsumer = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-relay-health",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      jsonRpcMethod: "agent.getHealth",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-relay-health",
          result: {
            status: "healthy",
            uptime_seconds: 10,
            sql_queue: { enabled: true, current_size: 1, max_size: 2, active_workers: 1 },
            queries: { total: 3, errors: 0, success_rate: 100, avg_latency_ms: 4 },
          },
        },
        { requestId: "req-relay-health" },
      ),
    );

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
    expect(getSocketAgentMetricsSnapshot().agentHealth.responsesTotal).toBe(1);
    expect(getSocketAgentMetricsSnapshot().agentHealth.lastQuerySuccessRate).toBe(100);
  });

  it("releases relay dispatch slot on stream open and terminates leaked streams on idle timeout", async () => {
    vi.useFakeTimers();
    const emitToConsumer = vi.fn();
    const releaseInner = vi.fn();
    const releaseAgentDispatchSlot = (() => {
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        releaseInner();
      };
    })();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-relay-stream-timeout",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      jsonRpcMethod: "sql.execute",
      releaseAgentDispatchSlot,
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-relay-stream-timeout",
          result: { stream_id: "stream-timeout-1" },
        },
        { requestId: "req-relay-stream-timeout" },
      ),
    );

    await vi.waitFor(() =>
      expect(getActiveStreamRouteByRequestId("req-relay-stream-timeout")).toMatchObject({
        streamId: "stream-timeout-1",
      }),
    );
    expect(releaseInner).toHaveBeenCalledTimes(1);
    expect(relayMetrics.streamDispatchSlotsReleasedOnOpen).toBe(1);

    await vi.advanceTimersByTimeAsync(env.socketRelayStreamIdleTimeoutMs + 1);

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(2));
    const [, eventName, outboundFrame] = emitToConsumer.mock.calls[1] as [string, string, unknown];
    expect(eventName).toBe(socketEvents.relayRpcComplete);
    const decoded = decodePayloadFrame(outboundFrame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toMatchObject({
        request_id: "req-relay-stream-timeout",
        stream_id: "stream-timeout-1",
        terminal_status: "error",
        error_code: "RELAY_STREAM_TIMEOUT",
      });
    }
    expect(relayMetrics.streamIdleTimeouts).toBe(1);
    expect(getActiveStreamRouteByRequestId("req-relay-stream-timeout")).toBeUndefined();
    expect(getRelayRequestRoute("req-relay-stream-timeout")).toBeUndefined();
    expect(releaseInner).toHaveBeenCalledTimes(1);
  });

  it("should invoke Socket.IO ack immediately after validation, before relay outbound", async () => {
    const callOrder: string[] = [];
    const ack = vi.fn(() => {
      callOrder.push("ack");
    });
    const emitToConsumer = vi.fn(() => {
      callOrder.push("emit");
    });
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-relay-early-ack",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-relay-early-ack",
          result: { ok: true },
        },
        { requestId: "req-relay-early-ack" },
      ),
      ack,
    );

    await vi.waitFor(() => {
      expect(ack).toHaveBeenCalledTimes(1);
      expect(emitToConsumer).toHaveBeenCalledTimes(1);
    });
    expect(callOrder).toEqual(["ack", "emit"]);
  });

  it("should fail fast instead of leaking an unhandled rejection on unexpected relay processing errors", async () => {
    const emitToConsumer = vi.fn();
    const ack = vi.fn();
    const policySpy = vi
      .spyOn(agentRegistry, "resolveEffectiveDispatchPolicy")
      .mockImplementation(() => {
        throw new Error("policy lookup failed");
      });
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer,
      emitRpcStreamPullForRoute: vi.fn(),
    });

    registerRelayRequestRoute({
      requestId: "req-relay-fail-fast",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "socket-test",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-relay-fail-fast",
          result: { stream_id: "stream-2" },
        },
        { requestId: "req-relay-fail-fast" },
      ),
      ack,
    );

    await vi.waitFor(() => {
      expect(ack).toHaveBeenCalledTimes(1);
      expect(emitToConsumer).toHaveBeenCalledTimes(1);
    });

    const [, eventName, outboundFrame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
    expect(eventName).toBe(socketEvents.relayRpcResponse);
    const decoded = decodePayloadFrame(outboundFrame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toMatchObject({
        jsonrpc: "2.0",
        id: "req-relay-fail-fast",
        error: {
          data: {
            code: "BRIDGE_INBOUND_PROCESSING_FAILED",
          },
        },
      });
    }
    expect(getRelayRequestRoute("req-relay-fail-fast")).toBeUndefined();
    policySpy.mockRestore();
  });

  it("should reject legacy stream opening when the agent already reached max concurrent streams", async () => {
    const reject = vi.fn();
    const basePolicy = agentRegistry.resolveEffectiveDispatchPolicy("agent-1");
    const policySpy = vi
      .spyOn(agentRegistry, "resolveEffectiveDispatchPolicy")
      .mockReturnValue({ ...basePolicy, maxConcurrentStreams: 1 });
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });

    upsertActiveStreamRoute({
      requestId: "existing-open-stream",
      agentSocketId: "socket-test",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
      streamId: "stream-existing",
    });

    registerRestPendingRequest({
      primaryRequestId: "req-stream-cap",
      correlationIds: ["req-stream-cap"],
      socketId: "socket-test",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve: vi.fn(),
      reject,
      timeoutHandle: createTimeoutHandle(),
      acked: false,
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
    });

    h.handleAgentRpcResponse(
      "socket-test",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-stream-cap",
          result: { stream_id: "stream-2" },
        },
        { requestId: "req-stream-cap" },
      ),
    );

    await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    expect(getActiveStreamRouteByRequestId("req-stream-cap")).toBeUndefined();
    expect(getRestPendingRequestByCorrelationId("req-stream-cap")).toBeUndefined();
    policySpy.mockRestore();
  });
});
