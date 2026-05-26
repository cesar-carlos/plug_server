import { createServer } from "node:http";

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as rpcBridge from "../../src/presentation/socket/hub/relay/rpc_bridge";
import { agentRegistry } from "../../src/presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "../../src/presentation/socket/hub/registries/conversation_registry";
import {
  closeSocketServer,
  createSocketServer,
  runAgentSocketDisconnectCleanup,
  runConsumerSocketDisconnectCleanup,
  runExpiredConversationCleanup,
} from "../../src/socket";
import { socketEvents } from "../../src/shared/constants/socket_events";

type HubSocket = {
  readonly id: string;
  readonly data: { user?: { principal_type?: string } };
  emit: ReturnType<typeof vi.fn>;
};

const createHubSocket = (id: string, principalType: "client" | "user" = "client"): HubSocket => ({
  id,
  data: { user: { principal_type: principalType } },
  emit: vi.fn(),
});

const createMockNamespace = (
  sockets = new Map<string, HubSocket>(),
): Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, unknown> =>
  ({ sockets }) as unknown as Namespace<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    unknown
  >;

describe("socket disconnect cleanup wiring", () => {
  afterEach(() => {
    agentRegistry.clear();
    conversationRegistry.clear();
    rpcBridge.resetSocketBridgeState();
    vi.restoreAllMocks();
  });

  it("should run agent disconnect cleanup in bridge-first order", () => {
    const callOrder: string[] = [];
    vi.spyOn(rpcBridge, "unregisterAgentBridgeSocket").mockImplementation(() => {
      callOrder.push("unregisterAgentBridgeSocket");
    });
    vi.spyOn(rpcBridge, "cleanupPendingRequestsForAgentSocket").mockImplementation(() => {
      callOrder.push("cleanupPendingRequestsForAgentSocket");
      return 0;
    });
    vi.spyOn(rpcBridge, "cleanupAgentInboundSocketState").mockImplementation(() => {
      callOrder.push("cleanupAgentInboundSocketState");
    });
    vi.spyOn(rpcBridge, "cleanupAgentStreamSubscriptions").mockImplementation(() => {
      callOrder.push("cleanupAgentStreamSubscriptions");
    });

    const socket = createHubSocket("agent-disconnect-1");
    runAgentSocketDisconnectCleanup(socket, createMockNamespace());

    expect(callOrder).toEqual([
      "unregisterAgentBridgeSocket",
      "cleanupPendingRequestsForAgentSocket",
      "cleanupAgentInboundSocketState",
      "cleanupAgentStreamSubscriptions",
    ]);
  });

  it("should run consumer disconnect cleanup in bridge-first order", () => {
    const callOrder: string[] = [];
    vi.spyOn(rpcBridge, "unregisterConsumerBridgeSocket").mockImplementation(() => {
      callOrder.push("unregisterConsumerBridgeSocket");
    });
    vi.spyOn(rpcBridge, "cleanupConsumerStreamSubscriptions").mockImplementation(() => {
      callOrder.push("cleanupConsumerStreamSubscriptions");
    });
    vi.spyOn(rpcBridge, "finalizeConversationsClosedByConsumerDisconnect").mockImplementation(
      () => {
        callOrder.push("finalizeConversationsClosedByConsumerDisconnect");
      },
    );

    const socket = createHubSocket("consumer-disconnect-1");
    runConsumerSocketDisconnectCleanup(socket, createMockNamespace());

    expect(callOrder).toEqual([
      "unregisterConsumerBridgeSocket",
      "cleanupConsumerStreamSubscriptions",
      "finalizeConversationsClosedByConsumerDisconnect",
    ]);
  });

  it("should emit relay:conversation.ended to the agent when the consumer disconnects", () => {
    const agentSocket = createHubSocket("agent-socket-1");
    const consumerSocket = createHubSocket("consumer-disconnect-relay");
    const agentsNsp = createMockNamespace(new Map([["agent-socket-1", agentSocket]]));

    conversationRegistry.create({
      conversationId: "conv-consumer-disconnect",
      consumerSocketId: consumerSocket.id,
      agentSocketId: agentSocket.id,
      agentId: "agent-1",
    });

    runConsumerSocketDisconnectCleanup(consumerSocket, agentsNsp);

    expect(agentSocket.emit).toHaveBeenCalledWith(socketEvents.relayConversationEnded, {
      success: true,
      conversationId: "conv-consumer-disconnect",
      requestId: "conv-consumer-disconnect",
      reason: "consumer_disconnected",
    });
    expect(conversationRegistry.findByConversationId("conv-consumer-disconnect")).toBeNull();
  });

  it("should emit relay:conversation.ended to consumer and agent when conversations expire by idle sweep", () => {
    const agentSocket = createHubSocket("agent-socket-expired");
    const consumerSocket = createHubSocket("consumer-socket-expired");
    const agentsNsp = createMockNamespace(new Map([["agent-socket-expired", agentSocket]]));
    const consumersNsp = createMockNamespace(
      new Map([["consumer-socket-expired", consumerSocket]]),
    );

    const expiredConversation = conversationRegistry.create({
      conversationId: "conv-idle-expired",
      consumerSocketId: consumerSocket.id,
      agentSocketId: agentSocket.id,
      agentId: "agent-1",
    });

    runExpiredConversationCleanup([expiredConversation], consumersNsp, agentsNsp);

    const expectedPayload = {
      success: true,
      conversationId: "conv-idle-expired",
      requestId: "conv-idle-expired",
      reason: "expired",
    };
    expect(consumerSocket.emit).toHaveBeenCalledWith(
      socketEvents.relayConversationEnded,
      expectedPayload,
    );
    expect(agentSocket.emit).toHaveBeenCalledWith(
      socketEvents.relayConversationEnded,
      expectedPayload,
    );
  });

  it("should invoke resetSocketBridgeState when the last socket server closes", async () => {
    const resetSpy = vi.spyOn(rpcBridge, "resetSocketBridgeState");
    const httpServer = createServer();
    const io = createSocketServer(httpServer);

    await closeSocketServer(io, "test_shutdown");

    expect(resetSpy).toHaveBeenCalledOnce();
  });

  it("should not reset global bridge state while another socket server remains active", async () => {
    const resetSpy = vi.spyOn(rpcBridge, "resetSocketBridgeState");
    const firstHttpServer = createServer();
    const secondHttpServer = createServer();
    const firstIo = createSocketServer(firstHttpServer);
    const secondIo = createSocketServer(secondHttpServer);

    await closeSocketServer(firstIo, "test_shutdown");

    expect(resetSpy).not.toHaveBeenCalled();
    await closeSocketServer(secondIo, "test_shutdown");
    expect(resetSpy).toHaveBeenCalledOnce();
  });
});
