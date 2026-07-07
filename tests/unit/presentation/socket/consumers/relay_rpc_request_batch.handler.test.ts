import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/presentation/socket/hub/relay/rpc_bridge", () => ({
  dispatchRelayRpcToAgent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/registries/conversation_registry", () => ({
  conversationRegistry: {
    findInternalByConversationId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
}));

vi.mock(
  "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter",
  () => ({
    allowRelayRpcRequestAsync: vi.fn(async () => true),
    refundRelayRpcRequestAsync: vi.fn(),
  }),
);

vi.mock("../../../../../src/shared/metrics/socket_consumer.metrics", () => ({
  noteRelayBatchEnvelopeReceived: vi.fn(),
  noteRelayBatchAccepted: vi.fn(),
  noteRelayBatchRejected: vi.fn(),
  noteRelayFastPathRequested: vi.fn(),
  noteRelayFastPathForbidden: vi.fn(),
  noteServerTimingsOptIn: vi.fn(),
  observeRelayBatchEnvelopeDecodeMs: vi.fn(),
  observeRelayBatchItemsPerEnvelope: vi.fn(),
}));

vi.mock("../../../../../src/application/services/bridge_latency_trace_builder", () => ({
  createBridgeLatencyTraceForRequest: vi.fn(() => ({
    hasDispatchMeta: () => false,
    isFinalized: () => false,
    dismissWithoutPersist: vi.fn(),
    finalizeOnce: vi.fn(),
  })),
}));

// The overrides object lives on globalThis so it survives `vi.mock`'s
// hoisted factory closure. Tests mutate the same object to flip env values.
type BatchEnvOverrides = {
  socketRelayBatchEnabled: boolean;
  socketRelayBatchMaxItems: number;
  socketConsumerMaxInflightPerSocket: number;
  socketRelayFastPathForbidden: boolean;
};

declare global {
  let __batchEnvOverrides: BatchEnvOverrides | undefined;
}

globalThis.__batchEnvOverrides = {
  socketRelayBatchEnabled: true,
  socketRelayBatchMaxItems: 32,
  socketConsumerMaxInflightPerSocket: 32,
  socketRelayFastPathForbidden: false,
};

const overrides = globalThis.__batchEnvOverrides;

import type * as EnvModule from "../../../../../src/shared/config/env";

vi.mock("../../../../../src/shared/config/env", async () => {
  const actual = await vi.importActual<typeof EnvModule>("../../../../../src/shared/config/env");
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        const ov = globalThis.__batchEnvOverrides;
        if (ov && typeof prop === "string" && prop in ov) {
          return (ov as Record<string, unknown>)[prop];
        }
        return target[prop as string];
      },
    }),
  };
});

import { dispatchRelayRpcToAgent } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { refundRelayRpcRequestAsync, allowRelayRpcRequestAsync } from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import {
  noteRelayBatchAccepted,
  noteRelayBatchEnvelopeReceived,
  noteRelayBatchRejected,
  noteRelayFastPathForbidden,
  noteRelayFastPathRequested,
  noteServerTimingsOptIn,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";
import { createBridgeLatencyTraceForRequest } from "../../../../../src/application/services/bridge_latency_trace_builder";
import {
  handleRelayRpcRequestBatch,
  parseRelayRpcRequestBatchEnvelope,
} from "../../../../../src/presentation/socket/consumers/relay_rpc_request_batch.handler";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

const mockedDispatch = vi.mocked(dispatchRelayRpcToAgent);
const mockedFindConversation = vi.mocked(conversationRegistry.findInternalByConversationId);
const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedRefund = vi.mocked(refundRelayRpcRequestAsync);
const mockedAllowRelay = vi.mocked(allowRelayRpcRequestAsync);

interface MockedBatchSocket {
  readonly id: string;
  readonly connected: boolean;
  readonly data: {
    user: { sub: string; principal_type: string; role: string };
    inflightCounter?: { inflightCount: number };
  };
  readonly emit: ReturnType<typeof vi.fn>;
}

const buildSocket = (): MockedBatchSocket =>
  ({
    id: "consumer-batch-1",
    connected: true,
    data: {
      user: { sub: "user-1", principal_type: "user", role: "user" },
      inflightCounter: undefined,
    },
    emit: vi.fn(),
  }) as MockedBatchSocket;

const validCommand = (
  id: string,
): {
  jsonrpc: "2.0";
  id: string;
  method: "sql.execute";
  params: { sql: string; client_token: string };
} => ({
  jsonrpc: "2.0",
  id,
  method: "sql.execute",
  params: { sql: "SELECT 1", client_token: "t" },
});

const buildBatchFrame = (ids: readonly string[]): unknown =>
  encodePayloadFrame(
    ids.map((id) => validCommand(id)),
    { omitTraceId: true },
  );

describe("parseRelayRpcRequestBatchEnvelope", () => {
  it("accepts a minimal envelope with only conversationId + frame", () => {
    const result = parseRelayRpcRequestBatchEnvelope({
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope missing conversationId", () => {
    const result = parseRelayRpcRequestBatchEnvelope({ frame: {} });
    expect(result.success).toBe(false);
  });

  it("accepts opt-in flags (forward-compat for v2)", () => {
    const result = parseRelayRpcRequestBatchEnvelope({
      conversationId: "conv-1",
      frame: {},
      fastPath: true,
      requestServerTimings: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fastPath).toBe(true);
      expect(result.data.requestServerTimings).toBe(true);
    }
  });
});

describe("handleRelayRpcRequestBatch", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
    mockedFindConversation.mockReset();
    mockedAssertAccess.mockReset();
    mockedRefund.mockReset();
    mockedAllowRelay.mockReset();
    mockedAllowRelay.mockResolvedValue(true);
    vi.mocked(noteRelayBatchEnvelopeReceived).mockClear();
    vi.mocked(noteRelayBatchAccepted).mockClear();
    vi.mocked(noteRelayBatchRejected).mockClear();
    overrides.socketRelayBatchEnabled = true;
    overrides.socketRelayBatchMaxItems = 32;
    overrides.socketConsumerMaxInflightPerSocket = 32;
    overrides.socketRelayFastPathForbidden = false;

    vi.mocked(noteRelayFastPathRequested).mockClear();
    vi.mocked(noteRelayFastPathForbidden).mockClear();
    vi.mocked(noteServerTimingsOptIn).mockClear();
    vi.mocked(createBridgeLatencyTraceForRequest).mockClear();

    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-batch-1",
      agentId: "agent-1",
      agentSocketId: "agent-socket-1",
      createdAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
    });
    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
  });

  it("rejects with RELAY_BATCH_DISABLED when the feature flag is off", () => {
    overrides.socketRelayBatchEnabled = false;
    const socket = buildSocket();

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["r1"]),
    });

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.relayRpcBatchAccepted,
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "RELAY_BATCH_DISABLED" }),
      }),
    );
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(vi.mocked(noteRelayBatchRejected)).toHaveBeenCalledWith("disabled");
  });

  it("dispatches each item concurrently and returns a single batch_accepted ack", async () => {
    const socket = buildSocket();
    mockedDispatch.mockImplementation(async (input) => {
      // Hub-assigned id derived from client id for assertion purposes.
      return {
        requestId: `req-${input.consumerSocketId}-${Math.random().toString(16).slice(2, 6)}`,
        clientRequestId: "ignored",
      };
    });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b", "c"]),
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.anything(),
      ),
    );

    expect(mockedDispatch).toHaveBeenCalledTimes(3);

    const ack = socket.emit.mock.calls.find(
      (call) => call[0] === socketEvents.relayRpcBatchAccepted,
    )?.[1] as { success: true; batchSize: number; items: unknown[] };
    expect(ack.success).toBe(true);
    expect(ack.batchSize).toBe(3);
    expect(ack.items).toHaveLength(3);
  });

  it("passes preDecodedData to dispatchRelayRpcToAgent (no per-item encode/decode round-trip)", async () => {
    const socket = buildSocket();
    mockedDispatch.mockResolvedValue({ requestId: "req-1" });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b"]),
    });

    await vi.waitFor(() => expect(mockedDispatch).toHaveBeenCalledTimes(2));

    for (const call of mockedDispatch.mock.calls) {
      const input = call[0] as Record<string, unknown>;
      expect(input.preDecodedData).toBeDefined();
      expect(input.rawFramePayload).toBeUndefined();
      expect(input.preDecodedData).toMatchObject({
        jsonrpc: "2.0",
        method: "sql.execute",
      });
    }
  });

  it("forwards requestServerTimings and fastPath to each dispatch call", async () => {
    const socket = buildSocket();
    mockedDispatch.mockResolvedValue({ requestId: "req-1", fastPath: true });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b"]),
      requestServerTimings: true,
      fastPath: true,
    });

    await vi.waitFor(() => expect(mockedDispatch).toHaveBeenCalledTimes(2));

    expect(noteRelayFastPathRequested).toHaveBeenCalledTimes(1);
    expect(noteServerTimingsOptIn).toHaveBeenCalledTimes(1);
    expect(noteServerTimingsOptIn).toHaveBeenCalledWith("relay");
    expect(createBridgeLatencyTraceForRequest).toHaveBeenCalledTimes(2);

    for (const call of mockedDispatch.mock.calls) {
      expect(call[0]).toMatchObject({
        requestServerTimings: true,
        fastPath: true,
      });
    }
  });

  it("strips fastPath from dispatch when SOCKET_RELAY_FAST_PATH_FORBIDDEN is true", async () => {
    overrides.socketRelayFastPathForbidden = true;
    const socket = buildSocket();
    mockedDispatch.mockResolvedValue({ requestId: "req-1" });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a"]),
      fastPath: true,
    });

    await vi.waitFor(() => expect(mockedDispatch).toHaveBeenCalledTimes(1));

    expect(noteRelayFastPathRequested).toHaveBeenCalledTimes(1);
    expect(noteRelayFastPathForbidden).toHaveBeenCalledTimes(1);
    expect(mockedDispatch.mock.calls[0]![0]).not.toHaveProperty("fastPath");
  });

  it("rejects the entire batch with RATE_LIMITED when the inflight gate cannot fit all items", async () => {
    overrides.socketConsumerMaxInflightPerSocket = 2;
    const socket = buildSocket();
    mockedDispatch.mockResolvedValue({ requestId: "r" });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b", "c"]),
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: "RATE_LIMITED",
            details: expect.objectContaining({ availableSlots: 2, requestedSlots: 3 }),
          }),
        }),
      ),
    );
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedAllowRelay).toHaveBeenCalledWith("user-1", "consumer-batch-1", 3);
    expect(mockedRefund).toHaveBeenCalledWith("user-1", "consumer-batch-1", 3);
    expect(vi.mocked(noteRelayBatchRejected)).toHaveBeenCalledWith("inflight_gate");
  });

  it("charges relay rate-limit budget proportional to validated batch size", async () => {
    mockedAllowRelay.mockResolvedValue(false);
    const socket = buildSocket();

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b"]),
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: "RATE_LIMITED" }),
        }),
      ),
    );
    expect(mockedAllowRelay).toHaveBeenCalledWith("user-1", "consumer-batch-1", 2);
    expect(mockedRefund).not.toHaveBeenCalled();
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("rejects streaming-capable items with BATCH_STREAMING_ITEM_REJECTED", async () => {
    const socket = buildSocket();
    const streamingFrame = encodePayloadFrame(
      [
        validCommand("a"),
        {
          jsonrpc: "2.0",
          id: "b",
          method: "sql.execute",
          params: { sql: "SELECT 1", client_token: "t", options: { prefer_db_streaming: true } },
        },
      ],
      { omitTraceId: true },
    );

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: streamingFrame,
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: "BATCH_STREAMING_ITEM_REJECTED",
            details: expect.objectContaining({ itemIndex: 1 }),
          }),
        }),
      ),
    );
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("rejects batches without ids per item (BATCH_ITEM_REQUIRES_ID)", async () => {
    const socket = buildSocket();
    const frame = encodePayloadFrame(
      [{ jsonrpc: "2.0", method: "sql.execute", params: { sql: "SELECT 1", client_token: "t" } }],
      { omitTraceId: true },
    );

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame,
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: "BATCH_ITEM_REQUIRES_ID" }),
        }),
      ),
    );
  });

  it("rejects duplicate JSON-RPC ids within the batch", async () => {
    const socket = buildSocket();
    const frame = buildBatchFrame(["dup", "dup"]);

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame,
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: "BATCH_DUPLICATE_ID" }),
        }),
      ),
    );
  });

  it("rejects batches exceeding SOCKET_RELAY_BATCH_MAX_ITEMS", async () => {
    overrides.socketRelayBatchMaxItems = 2;
    const socket = buildSocket();

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b", "c"]),
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: "BATCH_TOO_LARGE",
            details: expect.objectContaining({ maxItems: 2, receivedItems: 3 }),
          }),
        }),
      ),
    );
  });

  it("reports per-item dedup state in the batch_accepted items array", async () => {
    const socket = buildSocket();
    mockedDispatch
      .mockResolvedValueOnce({
        requestId: "req-original",
        clientRequestId: "a",
        deduplicated: true,
        replayed: true,
      })
      .mockResolvedValueOnce({ requestId: "req-fresh", clientRequestId: "b" });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["a", "b"]),
    });

    await vi.waitFor(() => {
      const ack = socket.emit.mock.calls.find(
        (call) => call[0] === socketEvents.relayRpcBatchAccepted,
      )?.[1] as { items: Array<Record<string, unknown>> };
      expect(ack).toBeDefined();
      expect(ack.items[0]).toMatchObject({
        clientRequestId: "a",
        requestId: "req-original",
        deduplicated: true,
        replayed: true,
      });
      expect(ack.items[1]).toMatchObject({
        clientRequestId: "b",
        requestId: "req-fresh",
      });
    });
    expect(mockedRefund).toHaveBeenCalledTimes(1);
    expect(vi.mocked(noteRelayBatchAccepted)).toHaveBeenCalledWith({
      itemCount: 2,
      dedupedCount: 1,
      errorCount: 0,
    });
  });

  it("isolates per-item failures inside the items array; other items still succeed", async () => {
    const socket = buildSocket();
    const { AppError } = await import("../../../../../src/shared/errors/app_error");
    mockedDispatch
      .mockResolvedValueOnce({ requestId: "req-ok", clientRequestId: "ok" })
      .mockRejectedValueOnce(
        new AppError("Agent socket is unavailable", {
          code: "SERVICE_UNAVAILABLE",
          statusCode: 503,
        }),
      );

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: buildBatchFrame(["ok", "fail"]),
    });

    await vi.waitFor(() => {
      const ack = socket.emit.mock.calls.find(
        (call) => call[0] === socketEvents.relayRpcBatchAccepted,
      )?.[1] as { items: Array<Record<string, unknown>> };
      expect(ack).toBeDefined();
      expect(ack.items[0]).toMatchObject({ clientRequestId: "ok", requestId: "req-ok" });
      expect(ack.items[1]).toMatchObject({
        clientRequestId: "fail",
        error: expect.objectContaining({
          code: "SERVICE_UNAVAILABLE",
          statusCode: 503,
          itemIndex: 1,
        }),
      });
    });
    expect(vi.mocked(noteRelayBatchAccepted)).toHaveBeenCalledWith({
      itemCount: 2,
      dedupedCount: 0,
      errorCount: 1,
    });
  });

  it("rejects when conversation is not found", async () => {
    mockedFindConversation.mockReturnValue(undefined);
    const socket = buildSocket();

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "missing",
      frame: buildBatchFrame(["a"]),
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 }),
        }),
      ),
    );
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("rejects when frame.data is not an array (single command sent on the batch event)", async () => {
    const socket = buildSocket();
    const singleFrame = encodePayloadFrame(validCommand("solo"), { omitTraceId: true });

    handleRelayRpcRequestBatch(socket as never, {
      conversationId: "conv-1",
      frame: singleFrame,
    });

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcBatchAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: "BAD_REQUEST" }),
        }),
      ),
    );
    expect(vi.mocked(noteRelayBatchRejected)).toHaveBeenCalledWith("not_array");
  });
});
