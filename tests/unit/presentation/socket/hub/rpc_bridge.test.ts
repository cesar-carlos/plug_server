import type { Namespace } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import {
  relayMetrics,
  resetRelayHubHealthAndMetrics,
} from "../../../../../src/presentation/socket/hub/bridge_relay_health_metrics";
import {
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/relay_request_registry";
import { resetRelayOutboundQueueState } from "../../../../../src/presentation/socket/hub/relay_outbound_queue";
import {
  dispatchRpcCommandToAgent,
  findAgentBridgeSocketById,
  handleAgentRpcResponse,
  registerAgentBridgeSocket,
  registerConsumerBridgeServer,
  registerConsumerBridgeSocket,
  registerSocketBridgeServer,
  resetSocketBridgeState,
  unregisterAgentBridgeSocket,
  unregisterConsumerBridgeServer,
  unregisterSocketBridgeServer,
} from "../../../../../src/presentation/socket/hub/rpc_bridge";
import { resetRestAgentDispatchQueue } from "../../../../../src/presentation/socket/hub/rest_agent_dispatch_queue";
import { resetRestPendingRequestsStore } from "../../../../../src/presentation/socket/hub/rest_pending_requests";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

type MockSocket = {
  readonly id: string;
  emit: ReturnType<typeof vi.fn>;
};

const createMockSocket = (id: string): MockSocket => ({
  id,
  emit: vi.fn(),
});

const createMockNamespace = (
  sockets = new Map<string, MockSocket>(),
): Namespace => ({ sockets }) as unknown as Namespace;

describe("rpc_bridge orchestrator", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  afterEach(() => {
    resetSocketBridgeState();
    agentRegistry.clear();
    resetRestPendingRequestsStore();
    resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
    resetRelayRequestRegistry();
    resetRelayOutboundQueueState();
    resetRelayHubHealthAndMetrics();
    for (const handle of timeoutHandles.splice(0)) {
      clearTimeout(handle);
    }
    vi.clearAllMocks();
  });

  const createTimeoutHandle = (): NodeJS.Timeout => {
    const handle = setTimeout(() => undefined, 60_000);
    timeoutHandles.push(handle);
    return handle;
  };

  const registerReadyAgent = (agentId: string, socketId: string): void => {
    agentRegistry.registerAgentSession({
      agentId,
      socketId,
      userId: "user-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none", "gzip"],
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    agentRegistry.touch(agentId, { markProtocolReady: true, socketId });
  };

  it("should resolve findAgentBridgeSocketById for a registered live socket", () => {
    const agentSocket = createMockSocket("agent-socket-1");
    const agentsNsp = createMockNamespace(new Map([[agentSocket.id, agentSocket]]));
    registerSocketBridgeServer(agentsNsp);
    registerAgentBridgeSocket(agentsNsp, agentSocket.id);

    expect(findAgentBridgeSocketById(agentSocket.id)).toBe(agentSocket);
  });

  it("should return null and evict stale bridge index entries when the socket leaves the namespace", () => {
    const agentSocket = createMockSocket("agent-socket-stale");
    const agentsNsp = createMockNamespace(new Map([[agentSocket.id, agentSocket]]));
    registerSocketBridgeServer(agentsNsp);
    registerAgentBridgeSocket(agentsNsp, agentSocket.id);

    agentsNsp.sockets.delete(agentSocket.id);

    expect(findAgentBridgeSocketById(agentSocket.id)).toBeNull();
    registerAgentBridgeSocket(agentsNsp, agentSocket.id);
    agentsNsp.sockets.delete(agentSocket.id);
    expect(findAgentBridgeSocketById(agentSocket.id)).toBeNull();
  });

  it("should reject dispatch when the agent bridge server is not registered", async () => {
    registerReadyAgent("agent-offline-bridge", "agent-socket-offline-bridge");

    await expect(
      dispatchRpcCommandToAgent({
        agentId: "agent-offline-bridge",
        command: { jsonrpc: "2.0", method: "agent.getHealth", id: "req-bridge-off", params: {} },
      }),
    ).rejects.toThrow(/Socket bridge is not initialized/i);
  });

  it("should emit rpc:request to the registered agent socket when the bridge is online", async () => {
    const agentId = "agent-online";
    const agentSocket = createMockSocket("agent-socket-online");
    const agentsNsp = createMockNamespace(new Map([[agentSocket.id, agentSocket]]));
    registerSocketBridgeServer(agentsNsp);
    registerAgentBridgeSocket(agentsNsp, agentSocket.id);
    registerReadyAgent(agentId, agentSocket.id);

    const result = await dispatchRpcCommandToAgent({
      agentId,
      command: { jsonrpc: "2.0", method: "agent.ping", params: {} },
    });

    expect(result).toMatchObject({ notification: true, acceptedCommands: 1 });
    expect(agentSocket.emit).toHaveBeenCalledOnce();
    expect(agentSocket.emit.mock.calls[0]?.[0]).toBe(socketEvents.rpcRequest);
  });

  it("should route relay responses to the registered consumer socket", async () => {
    const consumerSocket = createMockSocket("consumer-route-1");
    const consumersNsp = createMockNamespace(new Map([[consumerSocket.id, consumerSocket]]));
    registerConsumerBridgeServer(consumersNsp);
    registerConsumerBridgeSocket(consumersNsp, consumerSocket.id);

    registerRelayRequestRoute({
      requestId: "req-relay-route",
      conversationId: "conv-route",
      consumerSocketId: consumerSocket.id,
      agentSocketId: "agent-socket-route",
      agentId: "agent-route",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    handleAgentRpcResponse(
      "agent-socket-route",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-relay-route",
          result: { ok: true },
        },
        { requestId: "req-relay-route" },
      ),
    );

    await vi.waitFor(() => expect(consumerSocket.emit).toHaveBeenCalledOnce());
    expect(consumerSocket.emit.mock.calls[0]?.[0]).toBe(socketEvents.relayRpcResponse);
  });

  it("should discard consumer emits and increment relayEmitDiscardedConsumerGone when the consumer socket is gone", async () => {
    const consumersNsp = createMockNamespace(new Map());
    registerConsumerBridgeServer(consumersNsp);
    const before = relayMetrics.relayEmitDiscardedConsumerGone;

    registerRelayRequestRoute({
      requestId: "req-relay-gone",
      conversationId: "conv-gone",
      consumerSocketId: "missing-consumer",
      agentSocketId: "agent-socket-gone",
      agentId: "agent-gone",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    handleAgentRpcResponse(
      "agent-socket-gone",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-relay-gone",
          result: { ok: true },
        },
        { requestId: "req-relay-gone" },
      ),
    );

    await vi.waitFor(() =>
      expect(relayMetrics.relayEmitDiscardedConsumerGone).toBe(before + 1),
    );
  });

  it("should skip consumer emits entirely when no consumer bridge server is registered", async () => {
    const before = relayMetrics.relayEmitDiscardedConsumerGone;

    registerRelayRequestRoute({
      requestId: "req-no-consumer-bridge",
      conversationId: "conv-no-consumer-bridge",
      consumerSocketId: "consumer-no-bridge",
      agentSocketId: "agent-socket-no-bridge",
      agentId: "agent-no-bridge",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    handleAgentRpcResponse(
      "agent-socket-no-bridge",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-no-consumer-bridge",
          result: { ok: true },
        },
        { requestId: "req-no-consumer-bridge" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relayMetrics.relayEmitDiscardedConsumerGone).toBe(before);
  });

  it("should unregister all agent socket index entries when the agent bridge server is removed", () => {
    const firstSocket = createMockSocket("agent-socket-a");
    const secondSocket = createMockSocket("agent-socket-b");
    const agentsNsp = createMockNamespace(
      new Map([
        [firstSocket.id, firstSocket],
        [secondSocket.id, secondSocket],
      ]),
    );
    registerSocketBridgeServer(agentsNsp);
    registerAgentBridgeSocket(agentsNsp, firstSocket.id);
    registerAgentBridgeSocket(agentsNsp, secondSocket.id);

    unregisterSocketBridgeServer(agentsNsp);

    expect(findAgentBridgeSocketById(firstSocket.id)).toBeNull();
    expect(findAgentBridgeSocketById(secondSocket.id)).toBeNull();
  });

  it("should clear bridge registration via resetSocketBridgeState", async () => {
    const agentSocket = createMockSocket("agent-socket-reset");
    const consumerSocket = createMockSocket("consumer-socket-reset");
    const agentsNsp = createMockNamespace(new Map([[agentSocket.id, agentSocket]]));
    const consumersNsp = createMockNamespace(new Map([[consumerSocket.id, consumerSocket]]));
    registerSocketBridgeServer(agentsNsp);
    registerConsumerBridgeServer(consumersNsp);
    registerAgentBridgeSocket(agentsNsp, agentSocket.id);
    registerConsumerBridgeSocket(consumersNsp, consumerSocket.id);
    registerReadyAgent("agent-reset", agentSocket.id);

    resetSocketBridgeState();

    expect(findAgentBridgeSocketById(agentSocket.id)).toBeNull();
    await expect(
      dispatchRpcCommandToAgent({
        agentId: "agent-reset",
        command: { jsonrpc: "2.0", method: "agent.getHealth", id: "req-reset", params: {} },
      }),
    ).rejects.toThrow(/Socket bridge is not initialized/i);
  });

  it("should remove a single agent bridge socket entry on unregisterAgentBridgeSocket", () => {
    const agentSocket = createMockSocket("agent-socket-unreg");
    const agentsNsp = createMockNamespace(new Map([[agentSocket.id, agentSocket]]));
    registerSocketBridgeServer(agentsNsp);
    registerAgentBridgeSocket(agentsNsp, agentSocket.id);

    unregisterAgentBridgeSocket(agentSocket.id);

    expect(findAgentBridgeSocketById(agentSocket.id)).toBeNull();
  });

  it("should remove consumer bridge socket entries when unregisterConsumerBridgeServer runs", () => {
    const consumerSocket = createMockSocket("consumer-socket-unreg");
    const consumersNsp = createMockNamespace(new Map([[consumerSocket.id, consumerSocket]]));
    registerConsumerBridgeServer(consumersNsp);
    registerConsumerBridgeSocket(consumersNsp, consumerSocket.id);

    unregisterConsumerBridgeServer(consumersNsp);

    const before = relayMetrics.relayEmitDiscardedConsumerGone;
    registerRelayRequestRoute({
      requestId: "req-after-consumer-unreg",
      conversationId: "conv-after-consumer-unreg",
      consumerSocketId: consumerSocket.id,
      agentSocketId: "agent-after-consumer-unreg",
      agentId: "agent-after-consumer-unreg",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });

    handleAgentRpcResponse(
      "agent-after-consumer-unreg",
      encodePayloadFrame(
        {
          jsonrpc: "2.0",
          id: "req-after-consumer-unreg",
          result: { ok: true },
        },
        { requestId: "req-after-consumer-unreg" },
      ),
    );

    expect(relayMetrics.relayEmitDiscardedConsumerGone).toBe(before);
  });
});
