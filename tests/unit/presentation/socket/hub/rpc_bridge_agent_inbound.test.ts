import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeLatencyTraceSession } from "../../../../../src/application/services/bridge_latency_trace_builder";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { createRpcBridgeAgentInboundHandlers } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_agent_inbound";
import {
  getActiveStreamRouteByRequestId,
  resetActiveStreamRegistry,
  upsertActiveStreamRoute,
} from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import {
  getRelayRequestRoute,
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  relayMetrics,
  resetRelayHubHealthAndMetrics,
} from "../../../../../src/presentation/socket/hub/relay/bridge_relay_health_metrics";
import { env } from "../../../../../src/shared/config/env";
import {
  getRestPendingRequestByCorrelationId,
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../../src/shared/metrics/socket_agent.metrics";
import {
  decodePayloadFrame,
  encodePayloadFrame,
} from "../../../../../src/shared/utils/payload_frame";
import {
  getSocketConsumerMetricsSnapshot,
  resetSocketConsumerMetrics,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";

describe("rpc_bridge_agent_inbound", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  beforeEach(() => {
    resetRestPendingRequestsStore();
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayHubHealthAndMetrics();
    resetSocketAgentMetrics();
    resetSocketConsumerMetrics();
    vi.useRealTimers();
  });

  afterEach(() => {
    resetRestPendingRequestsStore();
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayHubHealthAndMetrics();
    resetSocketAgentMetrics();
    resetSocketConsumerMetrics();
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

    // body.id is rewritten to the consumer's clientRequestId (JSON-RPC 2.0
    // §5 / fast-path requirement). See `docs/plug_agente/01_relay_body_id_echo.md`.
    expect(decodedByConsumer.get("consumer-a")).toEqual({
      jsonrpc: "2.0",
      id: "client-a",
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
      id: "client-b",
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
    // Two echoes (one per consumer).
    expect(getSocketConsumerMetricsSnapshot().relayOptIns.bodyIdEchoTotal).toBe(2);
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

  it("should pass PayloadFrame byte metadata to active stream chunk handlers", async () => {
    const onChunk = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });
    upsertActiveStreamRoute({
      requestId: "req-chunk-meta",
      agentSocketId: "socket-test",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk,
        onComplete: vi.fn(),
      },
      streamId: "stream-meta-1",
    });

    const chunkPayload = {
      request_id: "req-chunk-meta",
      stream_id: "stream-meta-1",
      chunk_index: 0,
      rows: [{ id: 1 }],
    };
    const frame = encodePayloadFrame(chunkPayload, { requestId: "req-chunk-meta" });

    h.handleAgentRpcChunk("socket-test", frame);

    await vi.waitFor(() => expect(onChunk).toHaveBeenCalledTimes(1));
    expect(onChunk).toHaveBeenCalledWith(chunkPayload, {
      originalSizeBytes: frame.originalSize,
      compressedSizeBytes: frame.compressedSize,
      compression: frame.cmp,
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

  it("should use PayloadFrame metadata for REST materialization byte accounting", async () => {
    const previousMaxBytes = env.socketRestSqlStreamMaterializeMaxBytes;
    const requestId = "req-rest-materialize-meta";
    const streamId = "stream-rest-materialize-meta";
    const resolve = vi.fn();
    const reject = vi.fn();
    const emitPull = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: emitPull,
    });
    const initialPayload = {
      jsonrpc: "2.0",
      id: requestId,
      result: { stream_id: streamId, rows: [] },
    };
    const initialFrame = encodePayloadFrame(initialPayload, { requestId });

    Object.defineProperty(env, "socketRestSqlStreamMaterializeMaxBytes", {
      value: initialFrame.originalSize + 16,
      configurable: true,
    });

    try {
      registerRestPendingRequest({
        primaryRequestId: requestId,
        correlationIds: [requestId],
        socketId: "socket-test",
        agentId: "agent-1",
        createdAtMs: Date.now(),
        resolve,
        reject,
        timeoutHandle: createTimeoutHandle(),
        acked: false,
        restStreamAggregate: true,
      });

      h.handleAgentRpcResponse("socket-test", initialFrame);

      await vi.waitFor(() => expect(getActiveStreamRouteByRequestId(requestId)).toBeDefined());
      const route = getActiveStreamRouteByRequestId(requestId);
      expect(route).toBeDefined();

      route?.onChunk(
        {
          request_id: requestId,
          stream_id: streamId,
          rows: [{ payload: "x".repeat(256) }],
        },
        {
          originalSizeBytes: 1,
          compressedSizeBytes: 1,
          compression: "none",
        },
      );

      expect(reject).not.toHaveBeenCalled();
      expect(getActiveStreamRouteByRequestId(requestId)).toBeDefined();
      expect(emitPull).toHaveBeenCalled();
    } finally {
      Object.defineProperty(env, "socketRestSqlStreamMaterializeMaxBytes", {
        value: previousMaxBytes,
        configurable: true,
      });
    }
  });

  it("should keep REST materialization byte accounting fallback when metadata is missing", async () => {
    const previousMaxBytes = env.socketRestSqlStreamMaterializeMaxBytes;
    const requestId = "req-rest-materialize-fallback";
    const streamId = "stream-rest-materialize-fallback";
    const reject = vi.fn();
    const h = createRpcBridgeAgentInboundHandlers({
      emitToConsumer: vi.fn(),
      emitRpcStreamPullForRoute: vi.fn(),
    });
    const initialPayload = {
      jsonrpc: "2.0",
      id: requestId,
      result: { stream_id: streamId, rows: [] },
    };
    const initialFrame = encodePayloadFrame(initialPayload, { requestId });

    Object.defineProperty(env, "socketRestSqlStreamMaterializeMaxBytes", {
      value: initialFrame.originalSize + 16,
      configurable: true,
    });

    try {
      registerRestPendingRequest({
        primaryRequestId: requestId,
        correlationIds: [requestId],
        socketId: "socket-test",
        agentId: "agent-1",
        createdAtMs: Date.now(),
        resolve: vi.fn(),
        reject,
        timeoutHandle: createTimeoutHandle(),
        acked: false,
        restStreamAggregate: true,
      });

      h.handleAgentRpcResponse("socket-test", initialFrame);

      await vi.waitFor(() => expect(getActiveStreamRouteByRequestId(requestId)).toBeDefined());
      getActiveStreamRouteByRequestId(requestId)?.onChunk({
        request_id: requestId,
        stream_id: streamId,
        rows: [{ payload: "x".repeat(256) }],
      });

      expect(reject).toHaveBeenCalledTimes(1);
      expect(getActiveStreamRouteByRequestId(requestId)).toBeUndefined();
    } finally {
      Object.defineProperty(env, "socketRestSqlStreamMaterializeMaxBytes", {
        value: previousMaxBytes,
        configurable: true,
      });
    }
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

  describe("relay forward bypass (perf optimization)", () => {
    /**
     * Cobre o caminho onde a route NÃO tem `requestServerTimings`: o forwarder
     * usa `encodeRelayOutboundFrameFromBytes` evitando re-stringify. O teste
     * verifica que o payload chega ao consumer com `id` original do agente
     * (preservado), e que o envelope carrega o `requestId` reassinado pelo hub.
     */
    it("forwards an unmodified response by reusing the decoded bytes when no mutation is needed", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      registerRelayRequestRoute({
        requestId: "req-bypass",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
      });

      const agentPayload = {
        jsonrpc: "2.0",
        id: "req-bypass",
        result: { rows: [{ x: 1 }, { x: 2 }] },
      };
      h.handleAgentRpcResponse(
        "socket-test",
        encodePayloadFrame(agentPayload, { requestId: "req-bypass" }),
      );

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , frame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        // Conteúdo exato do payload preservado bit a bit (sem mutação no meta).
        expect(decoded.value.data).toEqual(agentPayload);
        // Envelope reassinado pelo hub com o mesmo requestId.
        expect(decoded.value.frame.requestId).toBe("req-bypass");
      }
    });
  });

  describe("client_request_id echo (JSON-RPC 2.0 §5 / fast-path)", () => {
    /**
     * Regression guard for the relay unary fast-path defect (item 3 do
     * Colmeia server_adjustments; ver
     * `docs/plug_agente/01_relay_body_id_echo.md`). Quando a request relay
     * carrega um `clientRequestId` diferente do `requestId` interno do hub,
     * a resposta encaminhada ao consumer deve carregar `body.id =
     * clientRequestId` (contrato JSON-RPC 2.0 §5) mesmo que o agente tenha
     * respondido com o `requestId` da hub no body (comportamento legado).
     *
     * O envelope `PayloadFrame.requestId` continua sendo o `requestId` da
     * hub para preservar correlator wire-level e correlation_id em ops.
     */
    it("rewrites body.id from hub requestId to clientRequestId on response forwarding", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      registerRelayRequestRoute({
        requestId: "hub-uuid-1",
        clientRequestId: "client-id-abc",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
      });

      // Agent echoes back the body.id it received, which was overwritten by
      // the hub on dispatch to be `hub-uuid-1`. The fix rewrites that back
      // to the consumer's original id before forwarding.
      h.handleAgentRpcResponse(
        "socket-test",
        encodePayloadFrame(
          {
            jsonrpc: "2.0",
            id: "hub-uuid-1",
            result: { rows: [{ x: 1 }] },
          },
          { requestId: "hub-uuid-1" },
        ),
      );

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , frame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        const data = decoded.value.data as Record<string, unknown>;
        // body.id rewritten to consumer's id (JSON-RPC 2.0 §5 contract).
        expect(data.id).toBe("client-id-abc");
        // Envelope keeps the wire-level hub requestId for hub-internal
        // correlation. This is the regression guard the Colmeia spec asks
        // for in relay_unary_fast_path.md §1.
        expect(decoded.value.frame.requestId).toBe("hub-uuid-1");
      }
      expect(getSocketConsumerMetricsSnapshot().relayOptIns.bodyIdEchoTotal).toBe(1);
    });

    it("preserves the agent body.id (=requestId) when clientRequestId is missing", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      // Route registered without clientRequestId (e.g. internal sweep,
      // healthcheck, or a legacy consumer that omitted JSON-RPC `id`).
      registerRelayRequestRoute({
        requestId: "hub-uuid-2",
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
            id: "hub-uuid-2",
            result: { ok: true },
          },
          { requestId: "hub-uuid-2" },
        ),
      );

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , frame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        const data = decoded.value.data as Record<string, unknown>;
        expect(data.id).toBe("hub-uuid-2");
        expect(decoded.value.frame.requestId).toBe("hub-uuid-2");
      }
      // No rewrite happened, no metric tick.
      expect(getSocketConsumerMetricsSnapshot().relayOptIns.bodyIdEchoTotal).toBe(0);
    });

    it("rewrites body.id on synthetic compression_failed error too", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      registerRelayRequestRoute({
        requestId: "hub-uuid-3",
        clientRequestId: "client-id-xyz",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
      });

      // Forces decompression failure (cmp=gzip with invalid payload bytes).
      h.handleAgentRpcResponse("socket-test", {
        schemaVersion: "1.0",
        enc: "json",
        cmp: "gzip",
        contentType: "application/json",
        originalSize: 32,
        compressedSize: 3,
        payload: [1, 2, 3],
        requestId: "hub-uuid-3",
      });

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , outboundFrame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(outboundFrame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.data).toMatchObject({
          jsonrpc: "2.0",
          id: "client-id-xyz",
          error: {
            code: -32011,
            data: {
              reason: "compression_failed",
              // correlation_id still references the hub UUID for ops/support
              correlation_id: "corr-hub-uuid-3",
            },
          },
        });
        expect(decoded.value.frame.requestId).toBe("hub-uuid-3");
      }
      expect(getSocketConsumerMetricsSnapshot().relayOptIns.bodyIdEchoTotal).toBe(1);
    });
  });

  describe("meta.serverTimings injection (relay opt-in)", () => {
    const buildAgentResponseFrame = (id: string): unknown =>
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id,
          result: { ok: true },
        },
        { requestId: id },
      );

    it("does not attach meta.serverTimings when route did not opt in", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      registerRelayRequestRoute({
        requestId: "req-no-timings",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
      });

      h.handleAgentRpcResponse("socket-test", buildAgentResponseFrame("req-no-timings"));

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , frame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        const data = decoded.value.data as Record<string, unknown>;
        // No meta at all, or meta without serverTimings.
        const meta = data.meta as Record<string, unknown> | undefined;
        expect(meta?.serverTimings).toBeUndefined();
      }
    });

    it("attaches meta.serverTimings when route opted in and has an attached trace", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      // Build a real trace session and pre-populate phases so the snapshot
      // is observable.
      const trace = new BridgeLatencyTraceSession("relay", "user-1");
      trace.addPhaseMs("consumer_frame_decode_ms", 0.42);
      trace.addPhaseMs("encode_ms", 0.85);

      registerRelayRequestRoute({
        requestId: "req-with-timings",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
        requestServerTimings: true,
        latencyTrace: trace,
      });

      h.handleAgentRpcResponse("socket-test", buildAgentResponseFrame("req-with-timings"));

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , frame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        const data = decoded.value.data as Record<string, unknown>;
        const meta = data.meta as
          | { serverTimings?: { schemaVersion?: number; phasesMs?: Record<string, number> } }
          | undefined;
        expect(meta?.serverTimings).toBeDefined();
        expect(meta?.serverTimings?.schemaVersion).toBe(1);
        expect(meta?.serverTimings?.phasesMs).toMatchObject({
          consumer_frame_decode_ms: 0.42,
          encode_ms: 0.85,
        });
      }
    });

    it("does not attach meta.serverTimings when opt-in is on but trace is missing", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });

      // Defensive case: requestServerTimings set but no trace attached.
      // The forwarder must not throw and must not attach a partial envelope.
      registerRelayRequestRoute({
        requestId: "req-timings-no-trace",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
        requestServerTimings: true,
        // latencyTrace intentionally omitted
      });

      h.handleAgentRpcResponse("socket-test", buildAgentResponseFrame("req-timings-no-trace"));

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [, , frame] = emitToConsumer.mock.calls[0] as [string, string, unknown];
      const decoded = decodePayloadFrame(frame);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        const data = decoded.value.data as Record<string, unknown>;
        const meta = data.meta as Record<string, unknown> | undefined;
        expect(meta?.serverTimings).toBeUndefined();
      }
    });
  });

  describe("handleAgentRpcComplete", () => {
    it("invokes onComplete and removes a non-relay stream route", async () => {
      const onComplete = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer: vi.fn(),
        emitRpcStreamPullForRoute: vi.fn(),
      });
      upsertActiveStreamRoute({
        requestId: "req-complete",
        agentSocketId: "socket-test",
        streamHandlers: {
          consumerSocketId: "consumer-1",
          onChunk: vi.fn(),
          onComplete,
        },
        streamId: "stream-complete-1",
      });

      // `rpc:complete` is the stream terminal frame; per the inbound contract
      // `terminal_status` must be `aborted` or `error` and `total_rows` a
      // non-negative integer (normal row delivery happens via `rpc:chunk`).
      const completePayload = {
        request_id: "req-complete",
        stream_id: "stream-complete-1",
        total_rows: 0,
        terminal_status: "aborted",
      };
      h.handleAgentRpcComplete(
        "socket-test",
        encodePayloadFrame(completePayload, { requestId: "req-complete" }),
      );

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
      expect(onComplete.mock.calls[0]?.[0]).toMatchObject(completePayload);
      expect(getActiveStreamRouteByRequestId("req-complete")).toBeUndefined();
    });

    it("ignores a complete frame with no matching active stream route", async () => {
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer: vi.fn(),
        emitRpcStreamPullForRoute: vi.fn(),
      });

      // No route registered: handler must be a no-op (no throw, no leak).
      h.handleAgentRpcComplete(
        "socket-test",
        encodePayloadFrame(
          {
            request_id: "req-missing",
            stream_id: "stream-missing",
            total_rows: 0,
            terminal_status: "aborted",
          },
          { requestId: "req-missing" },
        ),
      );

      await vi.waitFor(() =>
        expect(getActiveStreamRouteByRequestId("req-missing")).toBeUndefined(),
      );
    });
  });

  describe("handleAgentRpcAck", () => {
    it("marks a matching REST pending request acked and clears its retry timer", async () => {
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer: vi.fn(),
        emitRpcStreamPullForRoute: vi.fn(),
      });
      registerRestPendingRequest({
        primaryRequestId: "req-ack",
        correlationIds: ["req-ack"],
        socketId: "socket-test",
        agentId: "agent-1",
        createdAtMs: Date.now(),
        resolve: vi.fn(),
        reject: vi.fn(),
        timeoutHandle: createTimeoutHandle(),
        acked: false,
        ackRetryTimer: createTimeoutHandle(),
      });

      h.handleAgentRpcAck(
        "socket-test",
        encodePayloadFrame(
          { request_id: "req-ack", received_at: "2026-05-25T13:00:00.000Z" },
          { requestId: "req-ack" },
        ),
      );

      await vi.waitFor(() =>
        expect(getRestPendingRequestByCorrelationId("req-ack")?.acked).toBe(true),
      );
      expect(getRestPendingRequestByCorrelationId("req-ack")).not.toHaveProperty("ackRetryTimer");
    });

    it("marks a matching relay route acked and forwards relayRpcRequestAck to its consumer", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });
      registerRelayRequestRoute({
        requestId: "req-ack-relay",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-test",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
        acked: false,
        ackRetryTimer: createTimeoutHandle(),
      });

      h.handleAgentRpcAck(
        "socket-test",
        encodePayloadFrame(
          { request_id: "req-ack-relay", received_at: "2026-05-25T13:00:00.000Z" },
          { requestId: "req-ack-relay" },
        ),
      );

      await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
      const [consumerSocketId, eventName] = emitToConsumer.mock.calls[0] as [
        string,
        string,
        unknown,
      ];
      expect(consumerSocketId).toBe("consumer-1");
      expect(eventName).toBe(socketEvents.relayRpcRequestAck);
      const route = getRelayRequestRoute("req-ack-relay");
      expect(route?.acked).toBe(true);
      expect(route).not.toHaveProperty("ackRetryTimer");
    });

    it("does not ack a relay route whose agentSocketId differs from the inbound socket", async () => {
      const emitToConsumer = vi.fn();
      const h = createRpcBridgeAgentInboundHandlers({
        emitToConsumer,
        emitRpcStreamPullForRoute: vi.fn(),
      });
      registerRelayRequestRoute({
        requestId: "req-ack-mismatch",
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "socket-owner",
        agentId: "agent-1",
        timeoutHandle: createTimeoutHandle(),
        createdAtMs: Date.now(),
        acked: false,
      });

      h.handleAgentRpcAck(
        "socket-attacker",
        encodePayloadFrame(
          { request_id: "req-ack-mismatch", received_at: "2026-05-25T13:00:00.000Z" },
          { requestId: "req-ack-mismatch" },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(emitToConsumer).not.toHaveBeenCalled();
      expect(getRelayRequestRoute("req-ack-mismatch")?.acked).toBe(false);
    });
  });
});
