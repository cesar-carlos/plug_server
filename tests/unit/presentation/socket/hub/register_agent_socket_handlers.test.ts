import type { Namespace } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/di/container", () => ({
  container: {
    agentProfileSyncService: {
      syncFromRegisterSnapshot: vi.fn(),
      syncFromConnectedAgent: vi.fn(),
    },
    agentSelfProfileService: {
      persistProfilePatch: vi.fn(),
      toPatchFromSocketPayload: vi.fn(),
    },
  },
}));

vi.mock("../../../../../src/presentation/socket/hub/relay/rpc_bridge", () => ({
  registerAgentBridgeSocket: vi.fn(),
  unregisterAgentBridgeSocket: vi.fn(),
  cleanupPendingRequestsForAgentSocket: vi.fn(() => 0),
  cleanupAgentInboundSocketState: vi.fn(),
  cleanupAgentStreamSubscriptions: vi.fn(),
  cleanupConversationStreamSubscriptions: vi.fn(),
  buildRelayConversationEndedPayload: vi.fn((conversationId: string, reason: string) => ({
    success: true,
    conversationId,
    requestId: conversationId,
    reason,
  })),
  dispatchRpcCommandToAgent: vi.fn(),
  handleAgentRpcResponse: vi.fn(),
  handleAgentRpcAck: vi.fn(),
  handleAgentBatchAck: vi.fn(),
  handleAgentRpcChunk: vi.fn(),
  handleAgentRpcComplete: vi.fn(),
}));

vi.mock("../../../../../src/application/services/agent_hub_presence_sync", () => ({
  syncAgentHubPresenceOnDisconnect: vi.fn(),
  syncAgentHubPresenceOnTouch: vi.fn(),
}));

import * as rpcBridge from "../../../../../src/presentation/socket/hub/relay/rpc_bridge";
import { registerAgentSocketConnectionHandlers } from "../../../../../src/presentation/socket/hub/register_agent_socket_handlers";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

describe("registerAgentSocketConnectionHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should register disconnect cleanup before identity-room join so join failures still clean up", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let connectionHandler: ((socket: unknown) => void | Promise<void>) | undefined;

    const agentsNsp = {
      on: (event: string, handler: (socket: unknown) => void | Promise<void>) => {
        if (event === "connection") {
          connectionHandler = handler;
        }
      },
    } as unknown as Namespace;

    const consumersNsp = { sockets: new Map() } as unknown as Namespace;

    const socket = {
      id: "agent-room-join-fail",
      data: { user: { sub: "user-room-join-fail" } },
      emit: vi.fn(),
      join: vi.fn().mockRejectedValue(new Error("room join failed")),
      disconnect: vi.fn(() => {
        listeners.get("disconnect")?.();
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.set(event, handler);
      }),
    };

    registerAgentSocketConnectionHandlers({ agentsNsp, consumersNsp });
    expect(connectionHandler).toBeTypeOf("function");

    await connectionHandler!(socket);

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.appError,
      expect.objectContaining({
        code: "ROOM_JOIN_FAILED",
      }),
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    // Early disconnect registration: cleanup ran when disconnect(true) fired the listener.
    expect(rpcBridge.unregisterAgentBridgeSocket).toHaveBeenCalledWith("agent-room-join-fail");
    expect(rpcBridge.cleanupPendingRequestsForAgentSocket).toHaveBeenCalledWith(
      "agent-room-join-fail",
    );
    expect(rpcBridge.cleanupAgentInboundSocketState).toHaveBeenCalledWith("agent-room-join-fail");
    expect(rpcBridge.cleanupAgentStreamSubscriptions).toHaveBeenCalledWith("agent-room-join-fail");
    // Protocol handlers must not be registered after a failed join.
    expect(listeners.has(socketEvents.agentRegister)).toBe(false);
  });
});
