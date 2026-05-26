import { afterEach, describe, expect, it, vi } from "vitest";

import { createDispatchRpcCommandToAgent } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_command";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import {
  getRestPendingRequestByCorrelationId,
  getRestPendingRequestCount,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { resetRestAgentDispatchQueue } from "../../../../../src/presentation/socket/hub/relay/rest_agent_dispatch_queue";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import { resetRelayHubHealthAndMetrics } from "../../../../../src/presentation/socket/hub/relay/bridge_relay_health_metrics";
import { AgentDisconnectedBeforeDispatchError } from "../../../../../src/shared/errors/agent_disconnected_before_dispatch.error";
import { env } from "../../../../../src/shared/config/env";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { decodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

const originalAckRetryConfig = {
  enabled: env.socketAgentAckRetryEnabled,
  timeoutMs: env.socketAgentAckTimeoutMs,
  maxRetries: env.socketAgentAckMaxRetries,
};

const enableFastAckRetry = (): void => {
  env.socketAgentAckRetryEnabled = true;
  env.socketAgentAckTimeoutMs = 10;
  env.socketAgentAckMaxRetries = 1;
};

const waitForInitialEmit = async (emit: ReturnType<typeof vi.fn>): Promise<void> => {
  for (let attempt = 0; attempt < 10 && emit.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(emit).toHaveBeenCalledTimes(1);
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

describe("rpc_bridge_dispatch_command", () => {
  afterEach(() => {
    agentRegistry.clear();
    resetRestPendingRequestsStore();
    resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
    resetRelayRequestRegistry();
    resetActiveStreamRegistry();
    resetRelayHubHealthAndMetrics();
    env.socketAgentAckRetryEnabled = originalAckRetryConfig.enabled;
    env.socketAgentAckTimeoutMs = originalAckRetryConfig.timeoutMs;
    env.socketAgentAckMaxRetries = originalAckRetryConfig.maxRetries;
    vi.clearAllTimers();
    vi.useRealTimers();
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

  it("does not retry a non-idempotent command when the ACK is missing", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-no-retry";
    const socketId = "socket-no-retry";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "sql.execute",
        id: "write-no-retry",
        params: { sql: "UPDATE users SET name = 'x'" },
      },
      timeoutMs: 60_000,
    });

    await waitForInitialEmit(emit);
    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);
    expect(emit).toHaveBeenCalledTimes(1);

    getRestPendingRequestByCorrelationId("write-no-retry")?.resolve({
      jsonrpc: "2.0",
      id: "write-no-retry",
      result: {},
    });
    await expect(pendingPromise).resolves.toMatchObject({ requestId: "write-no-retry" });
  });

  it("retries an eligible command once using the same frame when the ACK is missing", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-retry";
    const socketId = "socket-retry";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "read-retry",
        params: {},
      },
      timeoutMs: 60_000,
    });

    await waitForInitialEmit(emit);
    const firstFrame = emit.mock.calls[0]?.[1];
    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[1]).toBe(firstFrame);

    getRestPendingRequestByCorrelationId("read-retry")?.resolve({
      jsonrpc: "2.0",
      id: "read-retry",
      result: { status: "healthy" },
    });
    await expect(pendingPromise).resolves.toMatchObject({ requestId: "read-retry" });
  });

  it("does not retry after the ACK is received", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-acked";
    const socketId = "socket-acked";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "read-acked",
        params: {},
      },
      timeoutMs: 60_000,
    });

    await waitForInitialEmit(emit);
    const pending = getRestPendingRequestByCorrelationId("read-acked");
    expect(pending).toBeDefined();
    pending!.acked = true;

    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);
    expect(emit).toHaveBeenCalledTimes(1);

    pending?.resolve({ jsonrpc: "2.0", id: "read-acked", result: { status: "healthy" } });
    await expect(pendingPromise).resolves.toMatchObject({ requestId: "read-acked" });
  });

  it("does not retry after the response settles the pending request", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-responded";
    const socketId = "socket-responded";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "read-responded",
        params: {},
      },
      timeoutMs: 60_000,
    });

    await waitForInitialEmit(emit);
    getRestPendingRequestByCorrelationId("read-responded")?.resolve({
      jsonrpc: "2.0",
      id: "read-responded",
      result: { status: "healthy" },
    });
    await expect(pendingPromise).resolves.toMatchObject({ requestId: "read-responded" });

    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does not retry after the agent socket disappears", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-disconnect";
    const socketId = "socket-disconnect";
    const emit = vi.fn();
    let socketAvailable = true;
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId && socketAvailable ? { emit } : null),
    });

    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "read-disconnect",
        params: {},
      },
      timeoutMs: 60_000,
    });

    await waitForInitialEmit(emit);
    socketAvailable = false;
    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);
    expect(emit).toHaveBeenCalledTimes(1);

    getRestPendingRequestByCorrelationId("read-disconnect")?.resolve({
      jsonrpc: "2.0",
      id: "read-disconnect",
      result: { status: "healthy" },
    });
    await expect(pendingPromise).resolves.toMatchObject({ requestId: "read-disconnect" });
  });

  it("does not retry after the request timeout removes the pending request", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    env.socketAgentAckTimeoutMs = 20;
    const agentId = "agent-timeout";
    const socketId = "socket-timeout";
    const emit = vi.fn();
    registerReadyAgent(agentId, socketId);

    const dispatch = createDispatchRpcCommandToAgent({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (id) => (id === socketId ? { emit } : null),
    });

    const pendingPromise = dispatch({
      agentId,
      command: {
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "read-timeout",
        params: {},
      },
      timeoutMs: 5,
    });

    await waitForInitialEmit(emit);
    const rejection = expect(pendingPromise).rejects.toThrow(
      /Timed out waiting for agent response/i,
    );
    await vi.advanceTimersByTimeAsync(5);
    await rejection;

    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);
    expect(emit).toHaveBeenCalledTimes(1);
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
