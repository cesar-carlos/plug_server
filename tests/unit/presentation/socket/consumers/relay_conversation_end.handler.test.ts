import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/conversation_registry", () => ({
  conversationRegistry: {
    findByConversationId: vi.fn(),
    removeByConversationId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/rpc_bridge", () => ({
  buildRelayConversationEndedPayload: vi.fn((conversationId: string, reason: string) => ({
    success: true,
    conversationId,
    reason,
  })),
  cleanupConversationStreamSubscriptions: vi.fn(),
  findAgentBridgeSocketById: vi.fn(),
}));

import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { handleRelayConversationEnd } from "../../../../../src/presentation/socket/consumers/relay_conversation_end.handler";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";
import {
  cleanupConversationStreamSubscriptions,
  findAgentBridgeSocketById,
} from "../../../../../src/presentation/socket/hub/rpc_bridge";

const mockedFindConversation = vi.mocked(conversationRegistry.findByConversationId);
const mockedRemoveConversation = vi.mocked(conversationRegistry.removeByConversationId);
const mockedCleanupConversation = vi.mocked(cleanupConversationStreamSubscriptions);
const mockedFindAgentBridgeSocketById = vi.mocked(findAgentBridgeSocketById);

const buildSocket = () =>
  ({
    id: "consumer-1",
    connected: true,
    data: { user: { sub: "user-1", role: "user" } },
    emit: vi.fn(),
  }) as const;

describe("handleRelayConversationEnd", () => {
  beforeEach(() => {
    mockedFindConversation.mockReset();
    mockedRemoveConversation.mockReset();
    mockedCleanupConversation.mockReset();
    mockedFindAgentBridgeSocketById.mockReset();
    mockedFindAgentBridgeSocketById.mockReturnValue(null);
  });

  it("emits success, notifies the agent, and cleans up stream subscriptions", () => {
    const socket = buildSocket();
    const agentSocket = { emit: vi.fn() };
    mockedFindAgentBridgeSocketById.mockReturnValue(agentSocket as never);
    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
    } as never);

    handleRelayConversationEnd(socket as never, {
      conversationId: "conv-1",
      requestId: " req-end-1 ",
    });

    expect(mockedRemoveConversation).toHaveBeenCalledWith("conv-1");
    expect(mockedCleanupConversation).toHaveBeenCalledWith("conv-1");
    expect(mockedFindAgentBridgeSocketById).toHaveBeenCalledWith("agent-socket-1");
    expect(agentSocket.emit).toHaveBeenCalledWith(socketEvents.relayConversationEnded, {
      success: true,
      conversationId: "conv-1",
      reason: "consumer_ended",
    });
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationEnded, {
      success: true,
      requestId: "req-end-1",
      conversationId: "conv-1",
      reason: "consumer_ended",
    });
  });

  it("does not emit when the socket is disconnected", () => {
    const socket = {
      ...buildSocket(),
      connected: false,
    };
    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
    } as never);

    handleRelayConversationEnd(socket as never, {
      conversationId: "conv-1",
      requestId: "req-end-1",
    });

    expect(mockedRemoveConversation).toHaveBeenCalledWith("conv-1");
    expect(mockedCleanupConversation).toHaveBeenCalledWith("conv-1");
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("keeps consumer success when the agent socket is absent", () => {
    const socket = buildSocket();
    mockedFindAgentBridgeSocketById.mockReturnValue(null);
    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
    } as never);

    handleRelayConversationEnd(socket as never, { conversationId: "conv-1" });

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationEnded, {
      success: true,
      conversationId: "conv-1",
      reason: "consumer_ended",
    });
  });

  it("emits NOT_FOUND when the conversation does not belong to the socket", () => {
    const socket = buildSocket();
    mockedFindConversation.mockReturnValue(null);

    handleRelayConversationEnd(socket as never, { conversationId: "conv-404" });

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayConversationEnded, {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Conversation not found",
        statusCode: 404,
      },
    });
  });

  it("does not echo invalid request ids on validation errors", () => {
    const socket = buildSocket();

    for (const requestId of ["", "r".repeat(129), 123]) {
      socket.emit.mockClear();

      handleRelayConversationEnd(socket as never, {
        conversationId: "",
        requestId,
      });

      const [, payload] = socket.emit.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.success).toBe(false);
      expect(payload).not.toHaveProperty("requestId");
    }
  });
});
