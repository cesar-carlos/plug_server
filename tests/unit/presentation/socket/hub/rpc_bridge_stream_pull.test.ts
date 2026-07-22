import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetActiveStreamRegistry,
  upsertActiveStreamRoute,
  getActiveStreamRouteByRequestId,
} from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import {
  getRelayRequestRoute,
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";
import { createPrepareAgentStreamPull } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge_stream_pull";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { resetRelayOutboundQueueState } from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";
import { addRelayStreamForwardedRows } from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { env } from "../../../../../src/shared/config/env";
import { decodePayloadFrame } from "../../../../../src/shared/utils/payload_frame";

describe("rpc_bridge_stream_pull", () => {
  const timeoutHandles: NodeJS.Timeout[] = [];

  afterEach(() => {
    resetActiveStreamRegistry();
    resetRelayRequestRegistry();
    resetRelayOutboundQueueState();
    agentRegistry.clear();
    vi.restoreAllMocks();
    for (const handle of timeoutHandles.splice(0)) {
      clearTimeout(handle);
    }
  });

  const createTimeoutHandle = (): NodeJS.Timeout => {
    const handle = setTimeout(() => undefined, 60_000);
    timeoutHandles.push(handle);
    return handle;
  };

  it("cleans up a relay stream and emits terminal complete when the agent socket is gone", async () => {
    const emitToConsumer = vi.fn();
    const prepare = createPrepareAgentStreamPull({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => null,
      emitToConsumer,
    });

    registerRelayRequestRoute({
      requestId: "req-1",
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: createTimeoutHandle(),
      createdAtMs: Date.now(),
    });
    upsertActiveStreamRoute({
      requestId: "req-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        conversationId: "conv-1",
        mode: "relay",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
      streamId: "stream-1",
    });
    addRelayStreamForwardedRows("req-1", 7);

    expect(() =>
      prepare({
        consumerSocketId: "consumer-1",
        conversationId: "conv-1",
        requestId: "req-1",
      }),
    ).toThrow("Agent socket is unavailable");

    await vi.waitFor(() => expect(emitToConsumer).toHaveBeenCalledTimes(1));

    const [consumerSocketId, eventName, outboundFrame] = emitToConsumer.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(consumerSocketId).toBe("consumer-1");
    expect(eventName).toBe(socketEvents.relayRpcComplete);
    const decoded = decodePayloadFrame(outboundFrame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toMatchObject({
        request_id: "req-1",
        stream_id: "stream-1",
        total_rows: 7,
        terminal_status: "error",
      });
    }

    expect(getActiveStreamRouteByRequestId("req-1")).toBeUndefined();
    expect(getRelayRequestRoute("req-1")).toBeUndefined();
  });

  it("rejects stream pull payloads with mismatched streamId and requestId", () => {
    const prepare = createPrepareAgentStreamPull({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (socketId) =>
        socketId === "agent-socket-1"
          ? {
              emit: vi.fn(),
            }
          : null,
      emitToConsumer: vi.fn(),
    });

    upsertActiveStreamRoute({
      requestId: "req-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
      streamId: "stream-1",
    });
    upsertActiveStreamRoute({
      requestId: "req-2",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
      streamId: "stream-2",
    });

    expect(() =>
      prepare({
        consumerSocketId: "consumer-1",
        streamId: "stream-1",
        requestId: "req-2",
      }),
    ).toThrow(/different stream routes/i);
  });

  it("clamps stream pull windows to the hub maximum when the agent is not registered", () => {
    const agentEmit = vi.fn();
    const prepare = createPrepareAgentStreamPull({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: (socketId) =>
        socketId === "agent-socket-1"
          ? {
              emit: agentEmit,
            }
          : null,
      emitToConsumer: vi.fn(),
    });

    upsertActiveStreamRoute({
      requestId: "req-clamp",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
      streamId: "stream-clamp",
    });

    const result = prepare({
      consumerSocketId: "consumer-1",
      requestId: "req-clamp",
      windowSize: env.socketRestStreamPullMaxWindowSize + 10,
    }).execute();

    expect(result.windowSize).toBe(env.socketRestStreamPullMaxWindowSize);
    expect(agentEmit).toHaveBeenCalledWith(socketEvents.rpcStreamPull, expect.anything());
    const decoded = decodePayloadFrame(agentEmit.mock.calls[0]?.[1]);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toMatchObject({
        request_id: "req-clamp",
        stream_id: "stream-clamp",
        window_size: env.socketRestStreamPullMaxWindowSize,
      });
    }
  });

  it("resolves stream pull window from pinned route agentId without findBySocketId", () => {
    const findBySocketIdSpy = vi.spyOn(agentRegistry, "findBySocketId");
    const resolveWindowSpy = vi.spyOn(agentRegistry, "resolveStreamPullWindow").mockReturnValue(8);
    vi.spyOn(agentRegistry, "isRegistered").mockReturnValue(true);

    const agentEmit = vi.fn();
    const prepare = createPrepareAgentStreamPull({
      hasRegisteredAgentSocketBridge: () => true,
      findAgentSocketById: () => ({ emit: agentEmit }),
      emitToConsumer: vi.fn(),
    });

    upsertActiveStreamRoute({
      requestId: "req-window",
      agentSocketId: "agent-socket-1",
      agentId: "agent-registered",
      streamHandlers: {
        consumerSocketId: "consumer-1",
        onChunk: vi.fn(),
        onComplete: vi.fn(),
      },
      streamId: "stream-window",
    });

    const prepared = prepare({
      consumerSocketId: "consumer-1",
      requestId: "req-window",
      windowSize: 16,
    });

    expect(prepared.windowSize).toBe(8);
    expect(resolveWindowSpy).toHaveBeenCalledWith("agent-registered", 1, 16);
    expect(findBySocketIdSpy).not.toHaveBeenCalled();
  });
});
