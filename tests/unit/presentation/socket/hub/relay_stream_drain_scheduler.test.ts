import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { env } from "../../../../../src/shared/config/env";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { decodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";
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
  addRelayStreamBufferedChunk,
  addRelayStreamForwardedRows,
  getRelayStreamBufferedBytes,
  resetRelayStreamFlowState,
  setRelayStreamFlowCredits,
} from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";
import { resetRelayOutboundQueueState } from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";
import {
  resetConsumerBridgeSocketLookupForTests,
  wireConsumerBridgeSocketLookup,
} from "../../../../../src/presentation/socket/hub/relay/relay_consumer_socket_lookup";
import { scheduleRelayStreamDrain } from "../../../../../src/presentation/socket/hub/relay/relay_stream_drain_scheduler";

afterEach(() => {
  resetConsumerBridgeSocketLookupForTests();
  resetRelayOutboundQueueState();
  resetRelayStreamFlowState();
  resetActiveStreamRegistry();
  resetRelayRequestRegistry();
  vi.restoreAllMocks();
});

const arrangeOverLimitStream = (): void => {
  vi.spyOn(env, "socketRelayOutboundMaxPendingBytesPerConsumer", "get").mockReturnValue(10);
  registerRelayRequestRoute({
    requestId: "req-hard-stream",
    conversationId: "conv-1",
    consumerSocketId: "consumer-1",
    agentSocketId: "agent-socket-1",
    agentId: "agent-1",
    timeoutHandle: setTimeout(() => undefined, 60_000),
    createdAtMs: Date.now(),
  });
  upsertActiveStreamRoute({
    requestId: "req-hard-stream",
    agentSocketId: "agent-socket-1",
    agentId: "agent-1",
    streamId: "stream-1",
    streamHandlers: {
      consumerSocketId: "consumer-1",
      onChunk: () => undefined,
      onComplete: () => undefined,
    },
  });
  setRelayStreamFlowCredits("req-hard-stream", 1);
  addRelayStreamBufferedChunk(
    "req-hard-stream",
    { request_id: "req-hard-stream", stream_id: "stream-1", rows: [{ n: 3 }] },
    30,
  );
  addRelayStreamForwardedRows("req-hard-stream", 2);
};

const schedule = (
  emitToConsumer: (socketId: string, eventName: string, frame: unknown) => boolean,
): void => {
  let scheduled = false;
  scheduleRelayStreamDrain({
    route: {
      requestId: "req-hard-stream",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      conversationId: "conv-1",
      agentId: "agent-1",
    },
    emitToConsumer,
    isActive: () => true,
    getDrainScheduled: () => scheduled,
    setDrainScheduled: (value) => {
      scheduled = value;
    },
    reschedule: () => undefined,
  });
};

describe("relay stream hard byte limit", () => {
  it("emits a correlated terminal with the already forwarded row count", async () => {
    arrangeOverLimitStream();
    vi.spyOn(env, "socketRelayOutboundHardLimitAction", "get").mockReturnValue("close_stream");
    const emitToConsumer = vi.fn<
      (consumerSocketId: string, eventName: string, payload: unknown) => boolean
    >(() => true);

    schedule(emitToConsumer);

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));
    const emitCall = emitToConsumer.mock.calls[0];
    if (emitCall === undefined) {
      throw new Error("expected consumer emit");
    }
    const [, eventName, wire] = emitCall;
    expect(eventName).toBe(socketEvents.relayRpcComplete);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toMatchObject({
        request_id: "req-hard-stream",
        stream_id: "stream-1",
        total_rows: 2,
        terminal_status: "error",
        error_code: "RELAY_OUTBOUND_BYTE_LIMIT",
      });
    }
    expect(getRelayStreamBufferedBytes("req-hard-stream")).toBe(0);
    expect(getActiveStreamRouteByRequestId("req-hard-stream")).toBeUndefined();
    expect(getRelayRequestRoute("req-hard-stream")).toBeUndefined();
  });

  it("uses disconnect as the terminal signal without queueing an undeliverable complete", () => {
    arrangeOverLimitStream();
    vi.spyOn(env, "socketRelayOutboundHardLimitAction", "get").mockReturnValue(
      "disconnect_consumer",
    );
    const disconnect = vi.fn();
    wireConsumerBridgeSocketLookup(() => ({ disconnect }) as unknown as Socket);
    const emitToConsumer = vi.fn(() => true);

    schedule(emitToConsumer);

    expect(disconnect).toHaveBeenCalledWith(true);
    expect(emitToConsumer).not.toHaveBeenCalled();
    expect(getActiveStreamRouteByRequestId("req-hard-stream")).toBeUndefined();
  });
});
