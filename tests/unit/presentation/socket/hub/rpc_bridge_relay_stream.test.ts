import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import { resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/active_stream_registry";
import { resetRelayOutboundQueueTails } from "../../../../../src/presentation/socket/hub/relay_outbound_queue";
import {
  createRelayStreamHandlers,
  emitRelayTimeoutResponse,
} from "../../../../../src/presentation/socket/hub/rpc_bridge_relay_stream";
import {
  getOrCreateRelayIdempotencyMap,
  resetRelayIdempotencyStore,
} from "../../../../../src/presentation/socket/hub/relay_idempotency_store";
import type { RelayRequestRoute } from "../../../../../src/presentation/socket/hub/relay_request_registry";
import { resetRelayRequestRegistry } from "../../../../../src/presentation/socket/hub/relay_request_registry";
import { relayStreamFlowState, resetRelayStreamFlowState } from "../../../../../src/presentation/socket/hub/relay_stream_flow_state";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

const fakeTimeout = {} as NodeJS.Timeout;

afterEach(() => {
  resetRelayStreamFlowState();
  resetRelayIdempotencyStore();
  resetRelayRequestRegistry();
  resetActiveStreamRegistry();
  resetRelayOutboundQueueTails();
});

const flushRelayOutbound = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const makeRoute = (overrides?: Partial<RelayRequestRoute>): RelayRequestRoute => ({
  requestId: "r1",
  conversationId: "conv1",
  consumerSocketId: "cons1",
  agentSocketId: "agentSock",
  agentId: "agent1",
  timeoutHandle: fakeTimeout,
  createdAtMs: Date.now(),
  ...overrides,
});

describe("rpc_bridge_relay_stream", () => {
  it("createRelayStreamHandlers forwards chunk when credits > 0", async () => {
    const emit = vi.fn();
    const route = makeRoute();
    relayStreamFlowState.creditsByRequestId.set("r1", 1);
    const h = createRelayStreamHandlers(route, emit);
    expect(h.mode).toBe("relay");
    h.onChunk({ stream_id: "s1" });
    await flushRelayOutbound();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe("cons1");
    expect(emit.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcChunk);
    expect(relayStreamFlowState.creditsByRequestId.get("r1")).toBe(0);
  });

  it("emitRelayTimeoutResponse emits error frame and stores idempotency response", async () => {
    const emit = vi.fn();
    const route = makeRoute({ clientRequestId: "cid1", requestId: "r99" });
    const map = getOrCreateRelayIdempotencyMap("conv1");
    map.set("cid1", { requestId: "r99", expiresAtMs: Date.now() + 60_000 });
    emitRelayTimeoutResponse(route, emit);
    await flushRelayOutbound();
    expect(emit).toHaveBeenCalledWith("cons1", socketEvents.relayRpcResponse, expect.anything());
    const updated = map.get("cid1");
    expect(updated?.responseFrame).toBeDefined();
  });

  it("createRelayStreamHandlers emits terminal complete on backpressure overflow", async () => {
    const emit = vi.fn();
    const route = makeRoute({ requestId: "r-overflow" });
    relayStreamFlowState.bufferedChunksByRequestId.set(
      "r-overflow",
      Array.from({ length: env.socketRelayMaxBufferedChunksPerRequest }, () => ({ rows: [] })),
    );
    relayStreamFlowState.totalBufferedChunks = env.socketRelayMaxBufferedChunksPerRequest;

    const h = createRelayStreamHandlers(route, emit);
    h.onChunk({
      stream_id: "stream-overflow",
      request_id: "r-overflow",
      rows: [{ id: 1 }],
    });

    await flushRelayOutbound();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcComplete);
  });
});
