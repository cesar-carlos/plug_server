import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
  resolveSocketActorRole: vi.fn(() => "user"),
}));

vi.mock("../../../../../src/presentation/socket/hub/registries/agent_registry", () => ({
  agentRegistry: {
    findByAgentId: vi.fn(),
    getSocketIdByAgentId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/registries/conversation_registry", () => ({
  conversationRegistry: {
    tryReserveAndCreate: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/relay/rpc_bridge", () => ({
  findAgentBridgeSocketById: vi.fn(),
}));

vi.mock(
  "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter",
  () => ({
    refundRelayConversationStartAsync: vi.fn(),
  }),
);

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

vi.mock("../../../../../src/application/services/agent_hub_presence_sync", () => ({
  resolveAgentHubPresenceRoute: vi.fn(async () => null),
}));

import {
  conflict,
  notFound,
  serviceUnavailable,
} from "../../../../../src/shared/errors/http_errors";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  extractRelayConversationStartRequestId,
  handleRelayConversationStart,
  parseRelayConversationStartEnvelope,
  shouldRefundRelayConversationStartRateLimit,
} from "../../../../../src/presentation/socket/consumers/relay_conversation_start.handler";
import { abortPendingConsumerCommands } from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { resolveAgentHubPresenceRoute } from "../../../../../src/application/services/agent_hub_presence_sync";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import { findAgentBridgeSocketById } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge";
import { refundRelayConversationStartAsync } from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";

const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedFindByAgentId = vi.mocked(agentRegistry.findByAgentId);
const mockedGetSocketIdByAgentId = vi.mocked(agentRegistry.getSocketIdByAgentId);
const mockedTryReserveAndCreate = vi.mocked(conversationRegistry.tryReserveAndCreate);
const mockedFindAgentBridgeSocketById = vi.mocked(findAgentBridgeSocketById);
const mockedRefundRelayConversationStart = vi.mocked(refundRelayConversationStartAsync);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);
const mockedReleaseInflight = vi.mocked(releaseSocketInflightSlot);
const mockedResolvePresenceRoute = vi.mocked(resolveAgentHubPresenceRoute);

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

describe("extractRelayConversationStartRequestId", () => {
  it("returns a trimmed requestId when it matches the public contract", () => {
    expect(
      extractRelayConversationStartRequestId({
        requestId: " req-start-1 ",
        agentId: "agent-1",
      }),
    ).toBe("req-start-1");
  });

  it("rejects empty, long, and non-string requestIds", () => {
    expect(extractRelayConversationStartRequestId({ requestId: "   " })).toBeUndefined();
    expect(extractRelayConversationStartRequestId({ requestId: "r".repeat(129) })).toBeUndefined();
    expect(extractRelayConversationStartRequestId({ requestId: 123 })).toBeUndefined();
  });
});

describe("handleRelayConversationStart", () => {
  beforeEach(() => {
    mockedAssertAccess.mockReset();
    mockedFindByAgentId.mockReset();
    mockedGetSocketIdByAgentId.mockReset();
    mockedTryReserveAndCreate.mockReset();
    mockedRefundRelayConversationStart.mockReset();
    mockedTryAcquire.mockReset();
    mockedReleaseInflight.mockReset();
    mockedResolvePresenceRoute.mockReset();
    mockedResolvePresenceRoute.mockResolvedValue(null);

    mockedTryAcquire.mockReturnValue(true);

    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
    mockedFindByAgentId.mockReturnValue({
      agentId: "agent-1",
      socketId: "agent-socket-1",
    } as never);
    mockedGetSocketIdByAgentId.mockReturnValue("agent-socket-1");
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
    const envelope = parseRelayConversationStartEnvelope({ agentId: "", requestId: "req-start" });

    expect(envelope.success).toBe(false);
    if (!envelope.success) {
      expect(envelope.errorMessage).toBeTruthy();
    }
  });

  it("emits success with requestId when relay conversation starts", async () => {
    const socket = buildSocket();

    await handleRelayConversationStart(socket as never, {
      agentId: "agent-1",
      requestId: "req-start-success",
    });

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: true,
      requestId: "req-start-success",
      conversationId: "conv-1",
      agentId: "agent-1",
      createdAt: "2026-04-18T17:00:00.000Z",
    });
  });

  it("keeps legacy relay conversation start payloads without requestId working", async () => {
    const socket = buildSocket();

    await handleRelayConversationStart(socket as never, { agentId: "agent-1" });

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: true,
      conversationId: "conv-1",
      agentId: "agent-1",
      createdAt: "2026-04-18T17:00:00.000Z",
    });
  });

  it("does not refund relay rate limit when the per-socket inflight gate is full", async () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = buildSocket();

    await handleRelayConversationStart(socket as never, {
      agentId: "agent-1",
      requestId: "req-start-inflight",
    });

    expect(mockedRefundRelayConversationStart).not.toHaveBeenCalled();
    expect(mockedReleaseInflight).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      requestId: "req-start-inflight",
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

    await handleRelayConversationStart(socket as never, {
      agentId: "agent-1",
      requestId: "req-start-conflict",
    });

    expect(mockedRefundRelayConversationStart).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      requestId: "req-start-conflict",
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

    await handleRelayConversationStart(socket as never, {
      agentId: "agent-1",
      requestId: "req-start-503",
    });

    expect(mockedRefundRelayConversationStart).toHaveBeenCalledWith("user-1", "consumer-1");
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      requestId: "req-start-503",
      error: expect.objectContaining({
        code: "SERVICE_UNAVAILABLE",
        statusCode: 503,
      }),
    });
  });

  it("does not refund quota when the agent is not registered", async () => {
    const socket = buildSocket();
    mockedFindByAgentId.mockReturnValue(undefined);
    mockedGetSocketIdByAgentId.mockReturnValue(null);

    await handleRelayConversationStart(socket as never, {
      agentId: "agent-1",
      requestId: "req-start-not-found",
    });

    expect(mockedRefundRelayConversationStart).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      requestId: "req-start-not-found",
      error: expect.objectContaining({
        code: "NOT_FOUND",
        statusCode: 404,
      }),
    });
  });

  it("returns 503 when the agent is only present on another hub instance", async () => {
    const socket = buildSocket();
    mockedFindByAgentId.mockReturnValue(undefined);
    mockedGetSocketIdByAgentId.mockReturnValue(null);
    mockedResolvePresenceRoute.mockResolvedValue({ hubInstanceId: "other-hub" });

    await handleRelayConversationStart(socket as never, {
      agentId: "agent-1",
      requestId: "req-start-remote-hub",
    });

    expect(mockedRefundRelayConversationStart).toHaveBeenCalledWith("user-1", "consumer-1");
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      requestId: "req-start-remote-hub",
      error: expect.objectContaining({
        code: "SERVICE_UNAVAILABLE",
        statusCode: 503,
        message: expect.stringContaining("another hub instance"),
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
