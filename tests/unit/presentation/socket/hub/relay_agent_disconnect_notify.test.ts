import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAgentStreamSubscriptions,
  resetRpcBridgeMutableStores,
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
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  resetRelayConsumerEmitForTests,
  wireRelayConsumerEmit,
} from "../../../../../src/presentation/socket/hub/relay/relay_consumer_emit";
import { resetRelayOutboundQueueTails } from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";

const flushRelayOutbound = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("cleanupAgentStreamSubscriptions agent disconnect notify", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  afterEach(() => {
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayConsumerEmitForTests();
    resetRelayOutboundQueueTails();
    resetRpcBridgeMutableStores();
    for (const handle of timeoutHandles.splice(0)) {
      clearTimeout(handle);
    }
  });

  const createTimeoutHandle = (): NodeJS.Timeout => {
    const handle = setTimeout(() => undefined, 60_000);
    timeoutHandles.push(handle);
    return handle;
  };

  it("emits AGENT_DISCONNECTED relay:rpc.response for pending unary relay routes", async () => {
    const emitToConsumer = vi.fn(() => true);
    wireRelayConsumerEmit(emitToConsumer);

    registerRelayRequestRoute({
      requestId: "req-unary",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
      clientRequestId: "client-req-1",
    });

    cleanupAgentStreamSubscriptions("agent-socket-1");
    await flushRelayOutbound();
    expect(getRelayRequestRoute("req-unary")).toBeUndefined();
    expect(emitToConsumer).toHaveBeenCalledOnce();
    expect(emitToConsumer.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcResponse);
  });

  it("emits relay:rpc.complete terminal error for active relay streams", async () => {
    const emitToConsumer = vi.fn(() => true);
    wireRelayConsumerEmit(emitToConsumer);

    const streamHandlers = {
      consumerSocketId: "consumer-1",
      conversationId: "conv-1",
      mode: "relay" as const,
      onChunk: vi.fn(),
      onComplete: vi.fn(),
    };

    registerRelayRequestRoute({
      requestId: "req-stream",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-stream",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      streamHandlers,
      streamId: "stream-1",
    });

    cleanupAgentStreamSubscriptions("agent-socket-1");
    await flushRelayOutbound();
    expect(getRelayRequestRoute("req-stream")).toBeUndefined();
    expect(getActiveStreamRouteByRequestId("req-stream")).toBeUndefined();
    expect(emitToConsumer).toHaveBeenCalledOnce();
    expect(emitToConsumer.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcComplete);
  });
});
