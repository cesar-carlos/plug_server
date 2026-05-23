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
  cleanupConversationStreamSubscriptions: vi.fn(),
}));

import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { handleRelayConversationEnd } from "../../../../../src/presentation/socket/consumers/relay_conversation_end.handler";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";
import { cleanupConversationStreamSubscriptions } from "../../../../../src/presentation/socket/hub/rpc_bridge";

const mockedFindConversation = vi.mocked(conversationRegistry.findByConversationId);
const mockedRemoveConversation = vi.mocked(conversationRegistry.removeByConversationId);
const mockedCleanupConversation = vi.mocked(cleanupConversationStreamSubscriptions);

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
  });

  it("emits success and cleans up stream subscriptions", () => {
    const socket = buildSocket();
    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentId: "agent-1",
    } as never);

    handleRelayConversationEnd(socket as never, {
      conversationId: "conv-1",
      requestId: "req-end-1",
    });

    expect(mockedRemoveConversation).toHaveBeenCalledWith("conv-1");
    expect(mockedCleanupConversation).toHaveBeenCalledWith("conv-1");
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
});
