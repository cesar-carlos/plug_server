import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import { resetActiveStreamRegistry } from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import { resetRelayOutboundQueueTails } from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";
import {
  createRelayStreamHandlers,
  emitRelayTimeoutResponse,
} from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_relay_stream";
import {
  getOrCreateRelayIdempotencyMap,
  resetRelayIdempotencyStore,
} from "../../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import type { RelayRequestRoute } from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import {
  setRelayStreamFlowCredits,
  getRelayStreamFlowCredits,
  addRelayStreamBufferedChunk,
  getRelayStreamBufferedBytes,
  resetRelayStreamFlowState,
} from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";
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
    registerRelayRequestRoute(route);
    setRelayStreamFlowCredits("r1", 1);
    const h = createRelayStreamHandlers(route, emit);
    expect(h.mode).toBe("relay");
    h.onChunk({ stream_id: "s1" });
    await flushRelayOutbound();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe("cons1");
    expect(emit.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcChunk);
    expect(getRelayStreamFlowCredits("r1")).toBe(0);
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
    registerRelayRequestRoute(route);
    for (let i = 0; i < env.socketRelayMaxBufferedChunksPerRequest; i++) {
      addRelayStreamBufferedChunk("r-overflow", { rows: [] });
    }

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

  it("createRelayStreamHandlers emits terminal complete on byte backpressure overflow", async () => {
    const emit = vi.fn();
    const route = makeRoute({ requestId: "r-byte-overflow" });
    registerRelayRequestRoute(route);
    addRelayStreamBufferedChunk(
      "r-byte-overflow",
      { rows: [] },
      env.socketRelayMaxBufferedBytesPerRequest,
    );

    const h = createRelayStreamHandlers(route, emit);
    h.onChunk({
      stream_id: "stream-byte-overflow",
      request_id: "r-byte-overflow",
      rows: [{ id: 1 }],
    });

    await flushRelayOutbound();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcComplete);
  });

  it("createRelayStreamHandlers uses metadata byte size when buffering chunks", async () => {
    const emit = vi.fn();
    const route = makeRoute({ requestId: "r-byte-metadata" });
    registerRelayRequestRoute(route);
    setRelayStreamFlowCredits("r-byte-metadata", 0);
    const initialBytes = env.socketRelayMaxBufferedBytesPerRequest - 8;
    addRelayStreamBufferedChunk("r-byte-metadata", { rows: [] }, initialBytes);

    const h = createRelayStreamHandlers(route, emit);
    h.onChunk(
      {
        stream_id: "stream-byte-metadata",
        request_id: "r-byte-metadata",
        rows: [{ payload: "x".repeat(256) }],
      },
      {
        originalSizeBytes: 4,
        compressedSizeBytes: 4,
        compression: "none",
      },
    );

    await flushRelayOutbound();
    expect(emit).not.toHaveBeenCalled();
    expect(getRelayStreamBufferedBytes("r-byte-metadata")).toBe(initialBytes + 4);
  });

  it("createRelayStreamHandlers emits only one terminal complete after overflow", async () => {
    const emit = vi.fn();
    const route = makeRoute({ requestId: "r-overflow-once" });
    registerRelayRequestRoute(route);
    for (let i = 0; i < env.socketRelayMaxBufferedChunksPerRequest; i++) {
      addRelayStreamBufferedChunk("r-overflow-once", { rows: [] });
    }

    const h = createRelayStreamHandlers(route, emit);
    h.onChunk({
      stream_id: "stream-overflow-once",
      request_id: "r-overflow-once",
      rows: [{ id: 1 }],
    });
    h.onChunk({
      stream_id: "stream-overflow-once",
      request_id: "r-overflow-once",
      rows: [{ id: 2 }],
    });

    await flushRelayOutbound();
    await flushRelayOutbound();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toBe(socketEvents.relayRpcComplete);
  });
});
