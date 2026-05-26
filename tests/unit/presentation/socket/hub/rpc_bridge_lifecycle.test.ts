import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRelayConversationEndedPayload,
  cleanupAgentStreamSubscriptions,
  cleanupConsumerStreamSubscriptions,
  cleanupConversationStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
  finalizeConversationsClosedByConsumerDisconnect,
  finalizeExpiredConversations,
} from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_lifecycle";
import {
  getActiveStreamRouteByRequestId,
  resetActiveStreamRegistry,
  upsertActiveStreamRoute,
} from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import {
  getRelayRequestRoute,
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  getRelayIdempotencyMap,
  resetRelayIdempotencyStore,
  setRelayIdempotencyEntry,
} from "../../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import {
  getRestPendingRequestCount,
  registerRestPendingRequest,
  resetRestPendingRequestsStore,
} from "../../../../../src/presentation/socket/hub/registries/rest_pending_requests";
import { env } from "../../../../../src/shared/config/env";

describe("rpc_bridge_lifecycle", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  afterEach(() => {
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayIdempotencyStore();
    resetRestPendingRequestsStore();
    for (const handle of timeoutHandles.splice(0)) {
      clearTimeout(handle);
    }
  });

  const createTimeoutHandle = (): NodeJS.Timeout => {
    const handle = setTimeout(() => undefined, 60_000);
    timeoutHandles.push(handle);
    return handle;
  };

  const streamHandlers = {
    consumerSocketId: "consumer-1",
    conversationId: "conv-1",
    mode: "relay" as const,
    onChunk: vi.fn(),
    onComplete: vi.fn(),
  };

  it("cleans relay routes and active streams for a disconnected consumer socket", () => {
    registerRelayRequestRoute({
      requestId: "req-consumer",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-consumer",
      agentSocketId: "agent-socket-1",
      streamHandlers,
      streamId: "stream-1",
    });

    cleanupConsumerStreamSubscriptions("consumer-1");

    expect(getActiveStreamRouteByRequestId("req-consumer")).toBeUndefined();
    expect(getRelayRequestRoute("req-consumer")).toBeUndefined();
  });

  it("cleans relay routes, active streams, and pending REST requests for a disconnected agent socket", () => {
    const reject = vi.fn();
    registerRestPendingRequest({
      primaryRequestId: "req-agent",
      correlationIds: ["req-agent"],
      socketId: "agent-socket-1",
      agentId: "agent-1",
      createdAtMs: Date.now(),
      resolve: vi.fn(),
      reject,
      timeoutHandle: createTimeoutHandle(),
      acked: false,
    });
    registerRelayRequestRoute({
      requestId: "req-agent",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-agent",
      agentSocketId: "agent-socket-1",
      streamHandlers,
      streamId: "stream-1",
    });

    const cleaned = cleanupPendingRequestsForAgentSocket("agent-socket-1");
    cleanupAgentStreamSubscriptions("agent-socket-1");

    expect(cleaned).toBe(1);
    expect(reject).toHaveBeenCalledOnce();
    expect(getRestPendingRequestCount()).toBe(0);
    expect(getActiveStreamRouteByRequestId("req-agent")).toBeUndefined();
    expect(getRelayRequestRoute("req-agent")).toBeUndefined();
  });

  it("clears conversation streams, relay routes, and idempotency entries on conversation end", () => {
    const conversationId = "conv-end";
    registerRelayRequestRoute({
      requestId: "req-conv",
      conversationId,
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-conv",
      agentSocketId: "agent-socket-1",
      streamHandlers: { ...streamHandlers, conversationId },
      streamId: "stream-1",
    });
    setRelayIdempotencyEntry(conversationId, "client-req-1", {
      requestId: "req-conv",
      expiresAtMs: Date.now() + env.socketRelayIdempotencyTtlMs,
    });

    cleanupConversationStreamSubscriptions(conversationId);

    expect(getActiveStreamRouteByRequestId("req-conv")).toBeUndefined();
    expect(getRelayRequestRoute("req-conv")).toBeUndefined();
    expect(getRelayIdempotencyMap(conversationId)).toBeUndefined();
  });

  it("builds relay conversation ended payloads for hub notifications", () => {
    expect(buildRelayConversationEndedPayload("conv-1", "consumer_disconnected")).toEqual({
      success: true,
      conversationId: "conv-1",
      requestId: "conv-1",
      reason: "consumer_disconnected",
    });
  });

  it("cleans up subscriptions and notifies the agent when consumer disconnect ends conversations", () => {
    const conversationId = "conv-consumer-disconnect";
    registerRelayRequestRoute({
      requestId: "req-consumer-disconnect",
      conversationId,
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-consumer-disconnect",
      agentSocketId: "agent-socket-1",
      streamHandlers: { ...streamHandlers, conversationId },
      streamId: "stream-1",
    });
    const notifyAgent = vi.fn();

    finalizeConversationsClosedByConsumerDisconnect(
      [
        {
          conversationId,
          consumerSocketId: "consumer-1",
          agentSocketId: "agent-socket-1",
          agentId: "agent-1",
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
      notifyAgent,
    );

    expect(notifyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        agentSocketId: "agent-socket-1",
      }),
    );
    expect(getActiveStreamRouteByRequestId("req-consumer-disconnect")).toBeUndefined();
    expect(getRelayRequestRoute("req-consumer-disconnect")).toBeUndefined();
  });

  it("cleans up subscriptions, idempotency, and notifies both parties when conversations expire", () => {
    const conversationId = "conv-idle-expired";
    registerRelayRequestRoute({
      requestId: "req-idle-expired",
      conversationId,
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-idle-expired",
      agentSocketId: "agent-socket-1",
      streamHandlers: { ...streamHandlers, conversationId },
      streamId: "stream-1",
    });
    setRelayIdempotencyEntry(conversationId, "client-req-expired", {
      requestId: "req-idle-expired",
      expiresAtMs: Date.now() + env.socketRelayIdempotencyTtlMs,
    });
    const notifyConsumer = vi.fn();
    const notifyAgent = vi.fn();

    finalizeExpiredConversations(
      [
        {
          conversationId,
          consumerSocketId: "consumer-1",
          agentSocketId: "agent-socket-1",
          agentId: "agent-1",
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
      notifyConsumer,
      notifyAgent,
    );

    expect(notifyConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        consumerSocketId: "consumer-1",
      }),
    );
    expect(notifyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        agentSocketId: "agent-socket-1",
      }),
    );
    expect(getActiveStreamRouteByRequestId("req-idle-expired")).toBeUndefined();
    expect(getRelayRequestRoute("req-idle-expired")).toBeUndefined();
    expect(getRelayIdempotencyMap(conversationId)).toBeUndefined();
  });
});
