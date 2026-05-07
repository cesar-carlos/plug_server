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

import { conflict } from "../../../../../src/shared/errors/http_errors";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { handleRelayConversationStart } from "../../../../../src/presentation/socket/consumers/relay_conversation_start.handler";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";

const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedFindByAgentId = vi.mocked(agentRegistry.findByAgentId);
const mockedTryReserveAndCreate = vi.mocked(conversationRegistry.tryReserveAndCreate);

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

const buildNamespace = () =>
  ({
    sockets: new Map([["agent-socket-1", { id: "agent-socket-1" }]]),
  }) as const;

describe("handleRelayConversationStart", () => {
  beforeEach(() => {
    mockedAssertAccess.mockReset();
    mockedFindByAgentId.mockReset();
    mockedTryReserveAndCreate.mockReset();

    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
    mockedFindByAgentId.mockReturnValue({
      agentId: "agent-1",
      socketId: "agent-socket-1",
    } as never);
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

  it("returns VALIDATION_ERROR on relay:conversation.started for invalid payloads", async () => {
    const socket = buildSocket();

    await handleRelayConversationStart(socket as never, { agentId: "" }, buildNamespace() as never);

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
    });
  });

  it("returns CONFLICT when the per-consumer cap is reached", async () => {
    const socket = buildSocket();
    mockedTryReserveAndCreate.mockReturnValue({
      ok: false,
      reason: "consumer_cap_reached",
    });

    await handleRelayConversationStart(
      socket as never,
      { agentId: "agent-1" },
      buildNamespace() as never,
    );

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationStarted, {
      success: false,
      error: {
        code: conflict("Consumer reached max active relay conversations").code,
        message: "Consumer reached max active relay conversations",
        statusCode: 409,
      },
    });
  });
});
