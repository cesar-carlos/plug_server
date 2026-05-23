import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/bridge_latency_trace_builder", () => ({
  createBridgeLatencyTraceIfSampled: vi.fn(() => null),
}));

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/rpc_bridge", () => ({
  dispatchRelayRpcToAgent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/conversation_registry", () => ({
  conversationRegistry: {
    findInternalByConversationId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
  resolveSocketActorRole: vi.fn(() => "user"),
}));

vi.mock("../../../../../src/presentation/socket/hub/consumer_relay_rate_limiter", () => ({
  refundRelayRpcRequestAsync: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

import { dispatchRelayRpcToAgent } from "../../../../../src/presentation/socket/hub/rpc_bridge";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";
import {
  handleRelayRpcRequest,
  shouldRefundRelayRpcRequestRateLimit,
} from "../../../../../src/presentation/socket/consumers/relay_rpc_request.handler";
import { abortPendingConsumerCommands } from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { refundRelayRpcRequestAsync } from "../../../../../src/presentation/socket/hub/consumer_relay_rate_limiter";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";

const mockedDispatchRelayRpcToAgent = vi.mocked(dispatchRelayRpcToAgent);
const mockedFindConversation = vi.mocked(conversationRegistry.findInternalByConversationId);
const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedRefundRelayRpc = vi.mocked(refundRelayRpcRequestAsync);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);
const mockedReleaseInflight = vi.mocked(releaseSocketInflightSlot);

const buildSocket = () =>
  ({
    id: "consumer-1",
    connected: true,
    data: {
      user: {
        sub: "user-1",
        principal_type: "user",
        role: "user",
      },
    },
    emit: vi.fn(),
  }) as const;

describe("shouldRefundRelayRpcRequestRateLimit", () => {
  it("does not refund 4xx client errors", () => {
    expect(
      shouldRefundRelayRpcRequestRateLimit(
        new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 }),
      ),
    ).toBe(false);
    expect(
      shouldRefundRelayRpcRequestRateLimit(
        new AppError("Bad request", { code: "BAD_REQUEST", statusCode: 400 }),
      ),
    ).toBe(false);
  });

  it("refunds transient and unexpected failures", () => {
    expect(
      shouldRefundRelayRpcRequestRateLimit(serviceUnavailable("Agent socket is unavailable")),
    ).toBe(true);
    expect(shouldRefundRelayRpcRequestRateLimit(new Error("boom"))).toBe(true);
  });
});

describe("handleRelayRpcRequest", () => {
  beforeEach(() => {
    mockedDispatchRelayRpcToAgent.mockReset();
    mockedFindConversation.mockReset();
    mockedAssertAccess.mockReset();
    mockedRefundRelayRpc.mockReset();
    mockedTryAcquire.mockReset();
    mockedReleaseInflight.mockReset();

    mockedTryAcquire.mockReturnValue(true);

    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentId: "agent-1",
      agentSocketId: "agent-socket-1",
      createdAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
    });
    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
  });

  it("emits VALIDATION_ERROR for malformed envelopes", () => {
    const socket = buildSocket();

    handleRelayRpcRequest(socket as never, { conversationId: "" });

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.relayRpcAccepted,
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
      }),
    );
    expect(mockedRefundRelayRpc).not.toHaveBeenCalled();
  });

  it("does not refund relay rate limit when the per-socket inflight gate is full", () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = buildSocket();

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    expect(mockedRefundRelayRpc).not.toHaveBeenCalled();
    expect(mockedReleaseInflight).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayRpcAccepted, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
  });

  it("does not emit relay accepted when socket is disconnected", () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = { ...buildSocket(), connected: false };

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("surfaces deduplicated in-flight accepts to the consumer", async () => {
    const socket = buildSocket();
    mockedDispatchRelayRpcToAgent.mockResolvedValue({
      requestId: "req-original",
      clientRequestId: "client-req-1",
      deduplicated: true,
      inFlight: true,
    });

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayRpcAccepted, {
        success: true,
        conversationId: "conv-1",
        requestId: "req-original",
        clientRequestId: "client-req-1",
        deduplicated: true,
        inFlight: true,
      });
    });
  });

  it("refunds quota on 503 when dispatch fails transiently", async () => {
    const socket = buildSocket();
    mockedDispatchRelayRpcToAgent.mockRejectedValue(
      serviceUnavailable("Agent socket is unavailable"),
    );

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => {
      expect(mockedRefundRelayRpc).toHaveBeenCalledWith("user-1", "consumer-1");
    });
  });

  it("does not refund quota when the conversation is not found", async () => {
    const socket = buildSocket();
    mockedFindConversation.mockReturnValue(undefined);

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcAccepted,
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 }),
        }),
      );
    });
    expect(mockedRefundRelayRpc).not.toHaveBeenCalled();
  });

  it("passes an abort signal to relay dispatch and aborts it when the consumer disconnects", async () => {
    const socket = buildSocket();
    let capturedSignal: AbortSignal | undefined;
    mockedDispatchRelayRpcToAgent.mockImplementation(async (input) => {
      capturedSignal = input.signal;
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { requestId: "req-abort" };
    });

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    expect(abortPendingConsumerCommands("consumer-1")).toBe(1);
    expect(capturedSignal?.aborted).toBe(true);
  });
});
