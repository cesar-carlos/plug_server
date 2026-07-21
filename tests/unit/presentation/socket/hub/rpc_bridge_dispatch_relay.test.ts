import { afterEach, describe, expect, it, vi } from "vitest";

import { createRpcBridgeRelayDispatch } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_dispatch_relay";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import {
  getRelayEffectivePendingCount,
  getRelayRegisteredRouteCount,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  resetRelayIdempotencyStore,
  setRelayIdempotencyEntry,
} from "../../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import { resetRelayStreamFlowState } from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";
import { env } from "../../../../../src/shared/config/env";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { encodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

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

afterEach(() => {
  agentRegistry.clear();
  conversationRegistry.clear();
  resetRelayRequestRegistry();
  resetRelayIdempotencyStore();
  resetRelayStreamFlowState();
  env.socketAgentAckRetryEnabled = originalAckRetryConfig.enabled;
  env.socketAgentAckTimeoutMs = originalAckRetryConfig.timeoutMs;
  env.socketAgentAckMaxRetries = originalAckRetryConfig.maxRetries;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("rpc_bridge_dispatch_relay", () => {
  it("marks deep validation bad requests as relay rate-limit refundable", async () => {
    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => false,
      findAgentSocketById: () => null,
      emitToConsumer: vi.fn(),
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    let caught: unknown;
    try {
      await handlers.dispatchRelayRpcToAgent({
        conversationId: "conv-1",
        consumerSocketId: "consumer-1",
        rawFramePayload: encodePayloadFrame({
          jsonrpc: "2.0",
          method: "sql.execute",
          id: null,
          params: { sql: "SELECT 1" },
        }),
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    if (caught instanceof AppError) {
      expect(caught.statusCode).toBe(400);
      expect(caught.details).toEqual({ refundRelayRpcRequestRateLimit: true });
    }
  });

  it("rejects JSON-RPC notifications (`id: null`) in relay:rpc.request", async () => {
    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => false,
      findAgentSocketById: () => null,
      emitToConsumer: () => {
        /* not reached in this test */
      },
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    const run = handlers.dispatchRelayRpcToAgent({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      rawFramePayload: encodePayloadFrame({
        jsonrpc: "2.0",
        method: "sql.execute",
        id: null,
        params: {
          sql: "SELECT 1",
        },
      }),
    });

    await expect(run).rejects.toThrow(/does not support JSON-RPC notifications/i);
  });

  it("cleans the relay route immediately when idempotency capacity rejects a new request", async () => {
    const agentId = "agent-idem-cap";
    const agentSocketId = "agent-socket-idem-cap";
    const consumerSocketId = "consumer-idem-cap";
    const conversationId = "conversation-idem-cap";
    const agentEmit = vi.fn();

    agentRegistry.registerAgentSession({
      agentId,
      socketId: agentSocketId,
      userId: "user-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    agentRegistry.touch(agentId, { markProtocolReady: true, socketId: agentSocketId });
    conversationRegistry.create({
      conversationId,
      consumerSocketId,
      agentSocketId,
      agentId,
    });

    const expiresAtMs = Date.now() + env.socketRelayIdempotencyTtlMs;
    for (let index = 0; index < env.socketRelayIdempotencyMaxEntriesPerConversation; index += 1) {
      const result = setRelayIdempotencyEntry(conversationId, `existing-${index}`, {
        requestId: `request-${index}`,
        expiresAtMs,
      });
      expect(result.ok).toBe(true);
    }

    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (socketId) =>
        socketId === agentSocketId
          ? {
              emit: agentEmit,
            }
          : null,
      emitToConsumer: vi.fn(),
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    await expect(
      handlers.dispatchRelayRpcToAgent({
        conversationId,
        consumerSocketId,
        rawFramePayload: encodePayloadFrame({
          jsonrpc: "2.0",
          method: "agent.getHealth",
          id: "client-request-over-cap",
          params: {},
        }),
      }),
    ).rejects.toThrow(/Relay idempotency capacity reached for conversation/i);

    expect(getRelayRegisteredRouteCount()).toBe(0);
    expect(agentEmit).not.toHaveBeenCalled();
  });

  it("retries a relay request with client_request_id once when the ACK is missing", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-relay-retry";
    const agentSocketId = "agent-socket-relay-retry";
    const consumerSocketId = "consumer-relay-retry";
    const conversationId = "conversation-relay-retry";
    const agentEmit = vi.fn();

    agentRegistry.registerAgentSession({
      agentId,
      socketId: agentSocketId,
      userId: "user-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    agentRegistry.touch(agentId, { markProtocolReady: true, socketId: agentSocketId });
    conversationRegistry.create({
      conversationId,
      consumerSocketId,
      agentSocketId,
      agentId,
    });

    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (socketId) =>
        socketId === agentSocketId
          ? {
              emit: agentEmit,
            }
          : null,
      emitToConsumer: vi.fn(),
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    const result = await handlers.dispatchRelayRpcToAgent({
      conversationId,
      consumerSocketId,
      rawFramePayload: encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "client-request-retry",
        params: {},
      }),
    });

    expect(result.clientRequestId).toBe("client-request-retry");
    expect(agentEmit).toHaveBeenCalledTimes(1);
    expect(agentEmit.mock.calls[0]?.[0]).toBe(socketEvents.rpcRequest);
    const firstFrame = agentEmit.mock.calls[0]?.[1];

    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);

    expect(agentEmit).toHaveBeenCalledTimes(2);
    expect(agentEmit.mock.calls[1]?.[1]).toBe(firstFrame);
  });

  it("does not retry relay when the agent socket disappears before the ACK timeout", async () => {
    vi.useFakeTimers();
    enableFastAckRetry();
    const agentId = "agent-relay-disconnect";
    const agentSocketId = "agent-socket-relay-disconnect";
    const consumerSocketId = "consumer-relay-disconnect";
    const conversationId = "conversation-relay-disconnect";
    const agentEmit = vi.fn();
    let socketAvailable = true;

    agentRegistry.registerAgentSession({
      agentId,
      socketId: agentSocketId,
      userId: "user-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    agentRegistry.touch(agentId, { markProtocolReady: true, socketId: agentSocketId });
    conversationRegistry.create({
      conversationId,
      consumerSocketId,
      agentSocketId,
      agentId,
    });

    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (socketId) =>
        socketId === agentSocketId && socketAvailable
          ? {
              emit: agentEmit,
            }
          : null,
      emitToConsumer: vi.fn(),
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    await handlers.dispatchRelayRpcToAgent({
      conversationId,
      consumerSocketId,
      rawFramePayload: encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "client-request-disconnect",
        params: {},
      }),
    });

    expect(agentEmit).toHaveBeenCalledTimes(1);
    socketAvailable = false;
    await vi.advanceTimersByTimeAsync(env.socketAgentAckTimeoutMs);
    expect(agentEmit).toHaveBeenCalledTimes(1);
  });

  it("releases pending reservation when agent protocol is not ready", async () => {
    const agentId = "agent-not-ready";
    const agentSocketId = "agent-socket-not-ready";
    const consumerSocketId = "consumer-not-ready";
    const conversationId = "conversation-not-ready";

    agentRegistry.registerAgentSession({
      agentId,
      socketId: agentSocketId,
      userId: "user-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
        extensions: { protocolReadyAck: true },
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    // Explicit-ack mode: leave protocol not ready (no markProtocolReady touch).
    conversationRegistry.create({
      conversationId,
      consumerSocketId,
      agentSocketId,
      agentId,
    });

    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit: vi.fn() }),
      emitToConsumer: vi.fn(),
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    const pendingBefore = getRelayEffectivePendingCount();
    await expect(
      handlers.dispatchRelayRpcToAgent({
        conversationId,
        consumerSocketId,
        rawFramePayload: encodePayloadFrame({
          jsonrpc: "2.0",
          method: "agent.getHealth",
          id: "client-not-ready",
          params: {},
        }),
      }),
    ).rejects.toThrow(/protocol negotiation is not ready/i);

    expect(getRelayEffectivePendingCount()).toBe(pendingBefore);
    expect(getRelayRegisteredRouteCount()).toBe(0);
  });

  it("releases pending reservation on idempotent in-flight dedupe", async () => {
    const agentId = "agent-dedupe-inflight";
    const agentSocketId = "agent-socket-dedupe-inflight";
    const consumerSocketId = "consumer-dedupe-inflight";
    const conversationId = "conversation-dedupe-inflight";

    agentRegistry.registerAgentSession({
      agentId,
      socketId: agentSocketId,
      userId: "user-1",
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    agentRegistry.touch(agentId, { markProtocolReady: true, socketId: agentSocketId });
    conversationRegistry.create({
      conversationId,
      consumerSocketId,
      agentSocketId,
      agentId,
    });

    setRelayIdempotencyEntry(conversationId, "client-dup", {
      requestId: "original-request",
      expiresAtMs: Date.now() + env.socketRelayIdempotencyTtlMs,
    });

    const handlers = createRpcBridgeRelayDispatch({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit: vi.fn() }),
      emitToConsumer: vi.fn(),
      prepareAgentStreamPull: () => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 1,
        execute: () => ({
          requestId: "req-1",
          streamId: "stream-1",
          windowSize: 1,
        }),
      }),
    });

    const pendingBefore = getRelayEffectivePendingCount();
    const result = await handlers.dispatchRelayRpcToAgent({
      conversationId,
      consumerSocketId,
      rawFramePayload: encodePayloadFrame({
        jsonrpc: "2.0",
        method: "agent.getHealth",
        id: "client-dup",
        params: {},
      }),
    });

    expect(result).toMatchObject({
      requestId: "original-request",
      clientRequestId: "client-dup",
      deduplicated: true,
      inFlight: true,
    });
    expect(getRelayEffectivePendingCount()).toBe(pendingBefore);
    expect(getRelayRegisteredRouteCount()).toBe(0);
  });
});
