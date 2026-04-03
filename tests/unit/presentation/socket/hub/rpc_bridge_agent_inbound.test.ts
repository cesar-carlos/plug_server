import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRpcBridgeAgentInboundHandlers } from "../../../../../src/presentation/socket/hub/rpc_bridge_agent_inbound";
import { getActiveStreamRouteByRequestId, resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/active_stream_registry";
import {
  getRestPendingRequestByCorrelationId,
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/rest_pending_requests";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

describe("rpc_bridge_agent_inbound", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  beforeEach(() => {
    resetRestPendingRequestsStore();
    resetActiveStreamRegistry();
  });

  afterEach(() => {
    resetRestPendingRequestsStore();
    resetActiveStreamRegistry();
    for (const handle of timeoutHandles.splice(0)) {
      clearTimeout(handle);
    }
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
});
