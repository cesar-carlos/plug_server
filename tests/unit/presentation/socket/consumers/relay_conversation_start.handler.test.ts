import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
  resolveSocketActorRole: vi.fn(() => "user"),
}));

vi.mock("../../../../../src/presentation/socket/hub/agent_registry", () => ({
  agentRegistry: {
    findByAgentId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/conversation_registry", () => ({
  conversationRegistry: {
    tryReserveAndCreate: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/rpc_bridge", () => ({
  findAgentBridgeSocketById: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/consumer_relay_rate_limiter", () => ({
  refundRelayConversationStartAsync: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

import {
  conflict,
  notFound,
  serviceUnavailable,
} from "../../../../../src/shared/errors/http_errors";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  handleRelayConversationStart,
  parseRelayConversationStartEnvelope,
  shouldRefundRelayConversationStartRateLimit,
} from "../../../../../src/presentation/socket/consumers/relay_conversation_start.handler";
import { abortPendingConsumerCommands } from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";
import { findAgentBridgeSocketById } from "../../../../../src/presentation/socket/hub/rpc_bridge";
import { refundRelayConversationStartAsync } from "../../../../../src/presentation/socket/hub/consumer_relay_rate_limiter";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";

const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedFindByAgentId = vi.mocked(agentRegistry.findByAgentId);
const mockedTryReserveAndCreate = vi.mocked(conversationRegistry.tryReserveAndCreate);
const mockedFindAgentBridgeSocketById = vi.mocked(findAgentBridgeSocketById);
const mockedRefundRelayConversationStart = vi.mocked(refundRelayConversationStartAsync);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);
const mockedReleaseInflight = vi.mocked(releaseSocketInflightSlot);

const buildSocket = () =>
  ({
    id: "consumer-1",
    data: {
      user: {
        sub: "user-1",
        principal_type: "user",
        role: "user",
      },
    },
    emit: vi.fn(),
  }) as const;

describe("shouldRefundRelayConversationStartRateLimit", () => {
  it("does not refund 4xx client errors", () => {
    expect(shouldRefundRelayConversationStartRateLimit(notFound("Agent agent-1"))).toBe(false);
    expect(shouldRefundRelayConversationStartRateLimit(conflict("Consumer cap"))).toBe(false);
  });

  it("refunds transient and unexpected failures", () => {
    expect(
      shouldRefundRelayConversationStartRateLimit(
        serviceUnavailable("Agent socket is unavailable"),
      ),
    ).toBe(true);
    expect(shouldRefundRelayConversationStartRateLimit(new Error("boom"))).toBe(true);
  });
});

describe("handleRelayConversationStart", () => {
  beforeEach(() => {
    mockedAssertAccess.mockReset();
    mockedFindByAgentId.mockReset();
    mockedTryReserveAndCreate.mockReset();
    mockedRefundRelayConversationStart.mockReset();
    mockedTryAcquire.mockReset();
    mockedReleaseInflight.mockReset();

    mockedTryAcquire.mockReturnValue(true);

    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
    mockedFindByAgentId.mockReturnValue({
      agentId: "agent-1",
      socketId: "agent-socket-1",
    } as never);
    mockedFindAgentBridgeSocketById.mockReset();
    mockedFindAgentBridgeSocketById.mockReturnValue({ id: "agent-socket-1" } as never);
    mockedTryReserveAndCreate.mockReturnValue({
      ok: true,
      conversation: {
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        agentSocketId: "agent-socket-1",
        agentId: "agent-1",
        createdAt: "2026-04-18T17:00:00.000Z",
        lastSeenAt: "2026-04-18T17:00:00.000Z",
      },
    });
  });

  it("returns VALIDATION_ERROR for invalid relay:conversation.start envelopes", () => {
    const envelope = parseRelayConversationStartEnvelope({ agentId: "" });

    expect(envelope.success).toBe(false);
    if (!envelope.success) {
      expect(envelope.errorMessage).toBeTruthy();
    }
  });

  it("does not refund relay rate limit when the per-socket inflight gate is full", async () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = buildSocket();

    await handleRelayConversationStart(socket as never, { agentId: "agent-1" });

    expect(mockedRefundRelayConversationStart).not.toHaveBeenCalled();
    expect(mockedReleaseInflight).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
  });

  it("returns CONFLICT when the per-consumer cap is reached", async () => {
    const socket = buildSocket();
    mockedTryReserveAndCreate.mockReturnValue({
      ok: false,
      reason: "consumer_cap_reached",
    });

    await handleRelayConversationStart(socket as never, { agentId: "agent-1" });

    expect(mockedRefundRelayConversationStart).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: {
        code: conflict("Consumer reached max active relay conversations").code,
        message: "Consumer reached max active relay conversations",
        statusCode: 409,
      },
    });
  });

  it("refunds quota on 503 when the agent bridge socket is unavailable", async () => {
    const socket = buildSocket();
    mockedFindAgentBridgeSocketById.mockReturnValue(undefined);

    await handleRelayConversationStart(socket as never, { agentId: "agent-1" });

    expect(mockedRefundRelayConversationStart).toHaveBeenCalledWith("user-1", "consumer-1");
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: expect.objectContaining({
        code: "SERVICE_UNAVAILABLE",
        statusCode: 503,
      }),
    });
  });

  it("does not refund quota when the agent is not registered", async () => {
    const socket = buildSocket();
    mockedFindByAgentId.mockReturnValue(undefined);

    await handleRelayConversationStart(socket as never, { agentId: "agent-1" });

    expect(mockedRefundRelayConversationStart).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: expect.objectContaining({
        code: "NOT_FOUND",
        statusCode: 404,
      }),
    });
  });

  it("does not create a conversation if the consumer disconnects while access is being checked", async () => {
    const socket = buildSocket();
    let resolveAccess!: () => void;
    mockedAssertAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccess = () => resolve({ type: "user", id: "user-1", role: "user" });
        }),
    );

    const run = handleRelayConversationStart(socket as never, { agentId: "agent-1" });

    await vi.waitFor(() => expect(mockedAssertAccess).toHaveBeenCalled());
    expect(abortPendingConsumerCommands("consumer-1")).toBe(1);
    resolveAccess();
    await run;

    expect(mockedRefundRelayConversationStart).toHaveBeenCalledWith("user-1", "consumer-1");
    expect(mockedTryReserveAndCreate).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Consumer socket disconnected before conversation start completed",
        statusCode: 503,
      },
    });
  });
});
