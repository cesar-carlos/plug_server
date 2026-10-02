import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addRelayStreamBufferedChunk,
  clearRelayStreamFlowState,
  drainRelayStreamBuffer,
  resetRelayStreamFlowState,
  setRelayStreamFlowCredits,
  setRelayStreamPendingComplete,
} from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(() => {
  resetRelayStreamFlowState();
  vi.useRealTimers();
});

describe("drainRelayStreamBuffer backpressure", () => {
  it("resumes after transport saturation without losing or duplicating chunks and emits complete last", async () => {
    const requestId = "pause-resume";
    setRelayStreamFlowCredits(requestId, 3);
    for (let index = 0; index < 3; index += 1)
      addRelayStreamBufferedChunk(requestId, { chunk_index: index }, 10);
    setRelayStreamPendingComplete(requestId, { done: true });
    const emitted: unknown[] = [];
    let writable = false;
    const input = {
      requestId,
      consumerSocketId: "c",
      agentSocketId: "a",
      conversationId: "conv",
      agentId: "agent",
      canEmitChunk: () => writable,
      emitChunk: (value: unknown) => {
        emitted.push(value);
        writable = false;
        return true;
      },
      emitComplete: (value: unknown) => {
        emitted.push(value);
        return true;
      },
      encodeFrame: async (value: unknown) => value,
      recordAudit: () => undefined,
    };
    expect((await drainRelayStreamBuffer(input)).pausedForBackpressure).toBe(true);
    expect(emitted).toEqual([]);
    for (let index = 0; index < 3; index += 1) {
      writable = true;
      await drainRelayStreamBuffer(input);
    }
    expect(emitted).toEqual([
      { chunk_index: 0 },
      { chunk_index: 1 },
      { chunk_index: 2 },
      { done: true },
    ]);
    await drainRelayStreamBuffer(input);
    expect(emitted).toHaveLength(4);
    clearRelayStreamFlowState(requestId);
  });
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

  it("uses encodeFrameFromBytes for pending complete when rawForward was captured", async () => {
    const requestId = "req-complete-bytes";
    setRelayStreamFlowCredits(requestId, 1);
    const rawForward = {
      bytes: Buffer.from(JSON.stringify({ stream_id: "s1", total_rows: 1 })),
      cmp: "none" as const,
    };
    setRelayStreamPendingComplete(requestId, { stream_id: "s1", total_rows: 1 }, rawForward);

    const encodeFrame = vi.fn(async () => {
      throw new Error("encodeFrame should not run");
    });
    const encodeFrameFromBytes = vi.fn(async () => ({ forwarded: true }));
    const emitComplete = vi.fn(() => true);

    const result = await drainRelayStreamBuffer({
      requestId,
      consumerSocketId: "c1",
      agentSocketId: "a1",
      conversationId: "conv1",
      agentId: "agent-1",
      emitChunk: () => true,
      emitComplete,
      encodeFrame,
      encodeFrameFromBytes,
      recordAudit: () => undefined,
    });

    expect(result.completeEmitted).toBe(true);
    expect(encodeFrameFromBytes).toHaveBeenCalledWith(rawForward);
    expect(encodeFrame).not.toHaveBeenCalled();
    expect(emitComplete).toHaveBeenCalledWith({ forwarded: true });
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
