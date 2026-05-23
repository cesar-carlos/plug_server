import { afterEach, describe, expect, it, vi } from "vitest";

import { createDispatchRpcCommandToAgent } from "../../../../../src/presentation/socket/hub/rpc_bridge_dispatch_command";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import {
  getRestPendingRequestByCorrelationId,
  getRestPendingRequestCount,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/rest_pending_requests";
import { resetRestAgentDispatchQueue } from "../../../../../src/presentation/socket/hub/rest_agent_dispatch_queue";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/relay_request_registry";
import { resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/active_stream_registry";
import { resetRelayHubHealthAndMetrics } from "../../../../../src/presentation/socket/hub/bridge_relay_health_metrics";
import { AgentDisconnectedBeforeDispatchError } from "../../../../../src/shared/errors/agent_disconnected_before_dispatch.error";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { decodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

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

describe("rpc_bridge_dispatch_command", () => {
  afterEach(() => {
    agentRegistry.clear();
    resetRestPendingRequestsStore();
    resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
    resetRelayRequestRegistry();
    resetActiveStreamRegistry();
    resetRelayHubHealthAndMetrics();
    vi.clearAllMocks();
  });

  it("rejects when the socket bridge is not initialized", async () => {
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => false,
      findAgentSocketById: () => null,
    });

    await expect(
      dispatch({
        agentId: "agent-1",
        command: { jsonrpc: "2.0", method: "agent.getHealth", id: "req-1", params: {} },
      }),
    ).rejects.toThrow(/Socket bridge is not initialized/i);
  });

  it("returns 404 when the agent is unknown", async () => {
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => null,
    });

    await expect(
      dispatch({
        agentId: "missing-agent",
        command: { jsonrpc: "2.0", method: "agent.getHealth", id: "req-1", params: {} },
      }),
    ).rejects.toThrow(/Agent missing-agent/i);
  });

  it("throws AgentDisconnectedBeforeDispatchError when the agent is known but disconnected", async () => {
    const agentId = "agent-offline";
    const socketId = "socket-offline";
    registerReadyAgent(agentId, socketId);
    agentRegistry.removeBySocketId(socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => null,
    });

    await expect(
      dispatch({
        agentId,
        command: { jsonrpc: "2.0", method: "agent.getHealth", id: "req-1", params: {} },
      }),
    ).rejects.toBeInstanceOf(AgentDisconnectedBeforeDispatchError);
  });

  it("rejects duplicate JSON-RPC ids that are already pending", async () => {
    const agentId = "agent-dup";
    const socketId = "socket-dup";
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit: vi.fn() } : null),
    });

    const command = {
      jsonrpc: "2.0" as const,
      method: "agent.getHealth",
      id: "dup-id",
      params: {},
    };

    const first = dispatch({ agentId, command, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(getRestPendingRequestCount()).toBe(1));

    await expect(dispatch({ agentId, command, timeoutMs: 60_000 })).rejects.toThrow(
      /already pending/i,
    );

    const pending = getRestPendingRequestByCorrelationId("dup-id");
    pending?.resolve({ ok: true });
    await expect(first).resolves.toMatchObject({ requestId: "dup-id" });
  });

  it("dispatches JSON-RPC notifications without registering a pending request", async () => {
    const agentId = "agent-notify";
    const socketId = "socket-notify";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const result = await dispatch({
      agentId,
      command: { jsonrpc: "2.0", method: "agent.ping", params: {} },
    });

    expect(result).toMatchObject({ notification: true, acceptedCommands: 1 });
    expect(getRestPendingRequestCount()).toBe(0);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]?.[0]).toBe(socketEvents.rpcRequest);
    const decoded = decodePayloadFrame(emit.mock.calls[0]?.[1]);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect((decoded.value.data as { method?: string }).method).toBe("agent.ping");
    }
  });

  it("registers a pending request and resolves when the agent responds", async () => {
    const agentId = "agent-pending";
    const socketId = "socket-pending";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const responsePayload = { jsonrpc: "2.0", id: "req-resolve", result: { healthy: true } };
    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "req-resolve",
        params: {},
      },
      timeoutMs: 60_000,
    });

    await vi.waitFor(() => expect(getRestPendingRequestCount()).toBe(1));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

    const pending = getRestPendingRequestByCorrelationId("req-resolve");
    pending?.resolve(responsePayload);

    await expect(pendingPromise).resolves.toEqual({
      requestId: "req-resolve",
      response: responsePayload,
    });
  });

  it("rejects immediately when the abort signal is already set", async () => {
    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit: vi.fn() }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      dispatch({
        agentId: "agent-abort",
        command: { jsonrpc: "2.0", method: "agent.getHealth", id: "req-abort", params: {} },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted by client/i);
  });
});
