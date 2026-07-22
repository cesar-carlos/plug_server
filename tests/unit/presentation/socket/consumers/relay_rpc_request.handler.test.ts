import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/bridge_latency_trace_builder", () => ({
  createBridgeLatencyTraceIfSampled: vi.fn(() => null),
  createBridgeLatencyTraceForRequest: vi.fn(() => null),
}));

vi.mock("../../../../../src/shared/metrics/socket_consumer.metrics", () => ({
  noteSocketErrorRetryAfterMsPropagated: vi.fn(),
  noteRelayFastPathRequested: vi.fn(),
  noteRelayFastPathHonored: vi.fn(),
  noteRelayFastPathFallbackDedup: vi.fn(),
  noteRelayFastPathFallbackError: vi.fn(),
  noteRelayFastPathForbidden: vi.fn(),
  noteServerTimingsOptIn: vi.fn(),
}));

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

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
  resolveSocketActorRole: vi.fn(() => "user"),
}));

vi.mock(
  "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter",
  () => ({
    refundRelayRpcRequestAsync: vi.fn(),
  }),
);

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

import { dispatchRelayRpcToAgent } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import {
  handleRelayRpcRequest,
  parseRelayRpcRequestEnvelope,
  shouldRefundRelayRpcRequestRateLimit,
} from "../../../../../src/presentation/socket/consumers/relay_rpc_request.handler";
import { abortPendingConsumerCommands } from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { refundRelayRpcRequestAsync } from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";
import {
  noteRelayFastPathFallbackDedup,
  noteRelayFastPathFallbackError,
  noteRelayFastPathForbidden,
  noteRelayFastPathHonored,
  noteRelayFastPathRequested,
  noteServerTimingsOptIn,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";
import { env } from "../../../../../src/shared/config/env";

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
  it("refunds marked deep validation 400 errors", () => {
    expect(
      shouldRefundRelayRpcRequestRateLimit(
        new AppError("Bad request", {
          code: "BAD_REQUEST",
          statusCode: 400,
          details: { refundRelayRpcRequestRateLimit: true },
        }),
      ),
    ).toBe(true);
  });

  it("does not refund unmarked bad request errors", () => {
    expect(
      shouldRefundRelayRpcRequestRateLimit(
        new AppError("Agent capabilities do not allow gzip compression for PayloadFrame", {
          code: "BAD_REQUEST",
          statusCode: 400,
        }),
      ),
    ).toBe(false);
  });

  it("does not refund authorization, routing, conflict, or rate-limit 4xx errors", () => {
    for (const statusCode of [401, 403, 404, 409, 429]) {
      expect(
        shouldRefundRelayRpcRequestRateLimit(
          new AppError(`status ${statusCode}`, { code: "CLIENT_ERROR", statusCode }),
        ),
      ).toBe(false);
    }
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
    vi.mocked(noteRelayFastPathRequested).mockReset();
    vi.mocked(noteRelayFastPathHonored).mockReset();
    vi.mocked(noteRelayFastPathFallbackDedup).mockReset();
    vi.mocked(noteRelayFastPathFallbackError).mockReset();
    vi.mocked(noteRelayFastPathForbidden).mockReset();
    vi.mocked(noteServerTimingsOptIn).mockReset();

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

  it("returns VALIDATION_ERROR for malformed relay:rpc.request envelopes", () => {
    const envelope = parseRelayRpcRequestEnvelope({ conversationId: "" });

    expect(envelope.success).toBe(false);
    if (!envelope.success) {
      expect(envelope.errorMessage).toBeTruthy();
    }
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
      conversationId: "conv-1",
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

  it("refunds quota on deep validation 400 when dispatch rejects as bad request", async () => {
    const socket = buildSocket();
    mockedDispatchRelayRpcToAgent.mockRejectedValue(
      new AppError("relay:rpc.request frame must contain a JSON object payload", {
        code: "BAD_REQUEST",
        statusCode: 400,
        details: { refundRelayRpcRequestRateLimit: true },
      }),
    );

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => {
      expect(mockedRefundRelayRpc).toHaveBeenCalledWith("user-1", "consumer-1");
    });
  });

  it("does not refund quota on unmarked bad request errors", async () => {
    const socket = buildSocket();
    mockedDispatchRelayRpcToAgent.mockRejectedValue(
      new AppError("Agent capabilities do not allow gzip compression for PayloadFrame", {
        code: "BAD_REQUEST",
        statusCode: 400,
      }),
    );

    handleRelayRpcRequest(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        socketEvents.relayRpcAccepted,
        expect.objectContaining({
          success: false,
          conversationId: "conv-1",
          error: expect.objectContaining({ code: "BAD_REQUEST", statusCode: 400 }),
        }),
      );
    });
    expect(mockedRefundRelayRpc).not.toHaveBeenCalled();
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
          conversationId: "conv-1",
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

  describe("fast-path opt-in", () => {
    it("accepts `fastPath: true` on the envelope schema", () => {
      const result = parseRelayRpcRequestEnvelope({
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fastPath).toBe(true);
      }
    });

    it("forwards the `fastPath` flag to dispatchRelayRpcToAgent", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-1",
        clientRequestId: "client-req-1",
        fastPath: true,
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      expect(mockedDispatchRelayRpcToAgent.mock.calls[0]?.[0]).toMatchObject({
        fastPath: true,
      });
    });

    it("accepts and forwards `timeoutMs` on the envelope", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-1",
        clientRequestId: "client-req-1",
      });

      const parsed = parseRelayRpcRequestEnvelope({
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        timeoutMs: 30_000,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.timeoutMs).toBe(30_000);
      }

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        timeoutMs: 30_000,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      expect(mockedDispatchRelayRpcToAgent.mock.calls[0]?.[0]).toMatchObject({
        timeoutMs: 30_000,
      });
    });

    it("skips relay:rpc.accepted when fast-path is honored on the non-dedup happy path", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-1",
        clientRequestId: "client-req-1",
        fastPath: true,
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      // No `accepted` emit on the fast-path happy case.
      expect(socket.emit).not.toHaveBeenCalledWith(
        socketEvents.relayRpcAccepted,
        expect.anything(),
      );
    });

    it("falls back to emitting relay:rpc.accepted when the request was deduplicated", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-original",
        clientRequestId: "client-req-1",
        deduplicated: true,
        replayed: true,
        fastPath: true,
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith(
          socketEvents.relayRpcAccepted,
          expect.objectContaining({
            success: true,
            deduplicated: true,
            replayed: true,
          }),
        );
      });
    });

    it("still emits relay:rpc.accepted on errors so the consumer is not left hanging", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockRejectedValue(
        new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 }),
      );

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
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
    });
  });

  describe("SOCKET_RELAY_FAST_PATH_FORBIDDEN deployment kill switch", () => {
    /**
     * Defesa para deployments com requirement de auditoria/compliance que
     * exigem o `relay:rpc.accepted` explicito. Quando o env esta on, mesmo
     * que o consumer envie `fastPath: true`, o hub forca o fluxo legado de
     * 3 eventos. Counter `fastPathForbiddenTotal` torna a deteccao
     * observavel em ops.
     */
    it("strips fastPath and emits relay:rpc.accepted when SOCKET_RELAY_FAST_PATH_FORBIDDEN is true", async () => {
      const originalForbidden = env.socketRelayFastPathForbidden;
      (env as { socketRelayFastPathForbidden: boolean }).socketRelayFastPathForbidden = true;
      try {
        const socket = buildSocket();
        mockedDispatchRelayRpcToAgent.mockResolvedValue({
          requestId: "req-1",
          clientRequestId: "client-req-1",
          // Dispatch does NOT receive fastPath because the handler stripped it.
        });

        handleRelayRpcRequest(socket as never, {
          conversationId: "conv-1",
          frame: { schemaVersion: "1.0" },
          fastPath: true,
        });

        await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());

        const dispatchInput = mockedDispatchRelayRpcToAgent.mock.calls[0]?.[0];
        // Stripped at the handler boundary — dispatcher never sees fastPath.
        expect(dispatchInput).not.toHaveProperty("fastPath");

        // Counters: requested AND forbidden, but NOT honored.
        expect(noteRelayFastPathRequested).toHaveBeenCalledTimes(1);
        expect(noteRelayFastPathForbidden).toHaveBeenCalledTimes(1);
        expect(noteRelayFastPathHonored).not.toHaveBeenCalled();

        // Consumer receives the legacy `relay:rpc.accepted` event.
        await vi.waitFor(() =>
          expect(socket.emit).toHaveBeenCalledWith(
            socketEvents.relayRpcAccepted,
            expect.objectContaining({ success: true, requestId: "req-1" }),
          ),
        );
      } finally {
        (env as { socketRelayFastPathForbidden: boolean }).socketRelayFastPathForbidden =
          originalForbidden;
      }
    });

    it("does not count fastPathForbidden when the consumer did not request fast-path", async () => {
      const originalForbidden = env.socketRelayFastPathForbidden;
      (env as { socketRelayFastPathForbidden: boolean }).socketRelayFastPathForbidden = true;
      try {
        const socket = buildSocket();
        mockedDispatchRelayRpcToAgent.mockResolvedValue({
          requestId: "req-1",
          clientRequestId: "client-req-1",
        });

        handleRelayRpcRequest(socket as never, {
          conversationId: "conv-1",
          frame: { schemaVersion: "1.0" },
          // fastPath omitted
        });

        await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());

        // Forbidden counter only ticks when there was a fast-path request to forbid.
        expect(noteRelayFastPathRequested).not.toHaveBeenCalled();
        expect(noteRelayFastPathForbidden).not.toHaveBeenCalled();
      } finally {
        (env as { socketRelayFastPathForbidden: boolean }).socketRelayFastPathForbidden =
          originalForbidden;
      }
    });
  });

  describe("requestServerTimings opt-in", () => {
    it("accepts `requestServerTimings: true` on the envelope schema", () => {
      const result = parseRelayRpcRequestEnvelope({
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        requestServerTimings: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.requestServerTimings).toBe(true);
      }
    });

    it("forwards the `requestServerTimings` flag to dispatchRelayRpcToAgent", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-1",
        clientRequestId: "client-req-1",
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        requestServerTimings: true,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      expect(mockedDispatchRelayRpcToAgent.mock.calls[0]?.[0]).toMatchObject({
        requestServerTimings: true,
      });
    });
  });

  describe("opt-in adoption metrics", () => {
    beforeEach(() => {
      vi.mocked(noteRelayFastPathRequested).mockClear();
      vi.mocked(noteRelayFastPathHonored).mockClear();
      vi.mocked(noteRelayFastPathFallbackDedup).mockClear();
      vi.mocked(noteRelayFastPathFallbackError).mockClear();
      vi.mocked(noteServerTimingsOptIn).mockClear();
    });

    it("increments fast-path requested + honored on the happy non-dedup path", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-1",
        clientRequestId: "client-req-1",
        fastPath: true,
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      expect(noteRelayFastPathRequested).toHaveBeenCalledTimes(1);
      expect(noteRelayFastPathHonored).toHaveBeenCalledTimes(1);
      expect(noteRelayFastPathFallbackDedup).not.toHaveBeenCalled();
      expect(noteRelayFastPathFallbackError).not.toHaveBeenCalled();
    });

    it("increments fast-path fallback_dedup when the request was deduplicated", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-original",
        clientRequestId: "client-req-1",
        deduplicated: true,
        replayed: true,
        fastPath: true,
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      expect(noteRelayFastPathHonored).not.toHaveBeenCalled();
      expect(noteRelayFastPathFallbackDedup).toHaveBeenCalledTimes(1);
    });

    it("increments fast-path fallback_error when dispatch rejects", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockRejectedValue(
        new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 }),
      );

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => expect(noteRelayFastPathFallbackError).toHaveBeenCalled());
      expect(noteRelayFastPathFallbackError).toHaveBeenCalledTimes(1);
    });

    it("echoes conversationId and clientRequestId on fastPath streaming-capable rejection", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockRejectedValue(
        new AppError("fastPath is not allowed for streaming-capable RPC methods", {
          code: "BAD_REQUEST",
          statusCode: 400,
          details: { clientRequestId: "4955b711-9444-4061-82bc-4d97e270b2b1" },
        }),
      );

      handleRelayRpcRequest(socket as never, {
        conversationId: "b04050f3-e9ea-498c-8d4e-ed0562b396a2",
        frame: { schemaVersion: "1.0" },
        fastPath: true,
      });

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayRpcAccepted, {
          success: false,
          conversationId: "b04050f3-e9ea-498c-8d4e-ed0562b396a2",
          clientRequestId: "4955b711-9444-4061-82bc-4d97e270b2b1",
          error: {
            code: "BAD_REQUEST",
            message: "fastPath is not allowed for streaming-capable RPC methods",
            statusCode: 400,
          },
        });
      });
    });

    it("increments server timings opt-in when consumer set requestServerTimings", async () => {
      const socket = buildSocket();
      mockedDispatchRelayRpcToAgent.mockResolvedValue({
        requestId: "req-1",
        clientRequestId: "client-req-1",
      });

      handleRelayRpcRequest(socket as never, {
        conversationId: "conv-1",
        frame: { schemaVersion: "1.0" },
        requestServerTimings: true,
      });

      await vi.waitFor(() => expect(mockedDispatchRelayRpcToAgent).toHaveBeenCalled());
      expect(noteServerTimingsOptIn).toHaveBeenCalledWith("relay");
    });
  });
});
