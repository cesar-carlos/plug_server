import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addRelayStreamBufferedChunk,
  clearRelayStreamFlowState,
  drainRelayStreamBuffer,
  resetRelayStreamFlowState,
  setRelayStreamFlowCredits,
} from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(() => {
  resetRelayStreamFlowState();
  vi.useRealTimers();
});

describe("drainRelayStreamBuffer backpressure", () => {
  it("pauses without popping when canEmitChunk is false and reports pausedForBackpressure", async () => {
    const requestId = "req-bp-1";
    setRelayStreamFlowCredits(requestId, 2);
    addRelayStreamBufferedChunk(requestId, { stream_id: "s1", rows: [{ a: 1 }] }, 10);

    const encodeFrame = vi.fn(async (data: unknown) => data);
    const emitChunk = vi.fn(() => true);

    const result = await drainRelayStreamBuffer({
      requestId,
      consumerSocketId: "c1",
      agentSocketId: "a1",
      conversationId: "conv1",
      agentId: "agent-1",
      canEmitChunk: () => false,
      emitChunk,
      emitComplete: () => true,
      encodeFrame,
      recordAudit: () => undefined,
    });

    expect(result).toEqual({
      chunksDrained: 0,
      completeEmitted: false,
      pausedForBackpressure: true,
    });
    expect(encodeFrame).not.toHaveBeenCalled();
    expect(emitChunk).not.toHaveBeenCalled();
    clearRelayStreamFlowState(requestId);
  });

  it("pauses after encode when emitChunk returns false", async () => {
    const requestId = "req-bp-2";
    setRelayStreamFlowCredits(requestId, 1);
    addRelayStreamBufferedChunk(requestId, { stream_id: "s1", rows: [{ a: 1 }] }, 10);

    const result = await drainRelayStreamBuffer({
      requestId,
      consumerSocketId: "c1",
      agentSocketId: "a1",
      conversationId: "conv1",
      agentId: "agent-1",
      emitChunk: () => false,
      emitComplete: () => true,
      encodeFrame: async (data) => data,
      recordAudit: () => undefined,
    });

    expect(result.pausedForBackpressure).toBe(true);
    expect(result.chunksDrained).toBe(0);
    clearRelayStreamFlowState(requestId);
  });
});
