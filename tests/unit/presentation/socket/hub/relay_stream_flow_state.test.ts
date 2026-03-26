import { afterEach, describe, expect, it } from "vitest";

import {
  clearRelayStreamFlowState,
  resetRelayStreamFlowState,
  addRelayStreamBufferedChunk,
  getRelayStreamBufferedChunks,
  getRelayStreamTotalBufferedChunks,
  setRelayStreamFlowCredits,
  getRelayStreamFlowCredits,
  setRelayStreamPendingComplete,
  getRelayStreamPendingComplete,
  addRelayStreamForwardedRows,
  drainRelayStreamBuffer,
  getRelayStreamForwardedRows,
} from "../../../../../src/presentation/socket/hub/relay_stream_flow_state";

afterEach(() => {
  resetRelayStreamFlowState();
});

describe("relay_stream_flow_state", () => {
  it("clearRelayStreamFlowState subtracts buffered length from total", () => {
    addRelayStreamBufferedChunk("r1", { a: 1 });
    addRelayStreamBufferedChunk("r1", { b: 2 });

    clearRelayStreamFlowState("r1");

    expect(getRelayStreamBufferedChunks("r1").length).toBe(0);
    expect(getRelayStreamTotalBufferedChunks()).toBe(0);
  });

  it("resetRelayStreamFlowState clears maps and total", () => {
    setRelayStreamFlowCredits("r1", 3);
    setRelayStreamPendingComplete("r1", {});
    addRelayStreamForwardedRows("r1", 7);
    addRelayStreamBufferedChunk("r2", {});

    resetRelayStreamFlowState();

    expect(getRelayStreamFlowCredits("r1")).toBe(0);
    expect(getRelayStreamPendingComplete("r1")).toBeUndefined();
    expect(getRelayStreamForwardedRows("r1")).toBe(0);
    expect(getRelayStreamTotalBufferedChunks()).toBe(0);
  });

  it("addRelayStreamFlowCredits increases credits", () => {
    setRelayStreamFlowCredits("r1", 5);
    expect(getRelayStreamFlowCredits("r1")).toBe(5);

    setRelayStreamFlowCredits("r1", 10);
    expect(getRelayStreamFlowCredits("r1")).toBe(10);
  });

  it("addRelayStreamBufferedChunk increments total", () => {
    addRelayStreamBufferedChunk("r1", { chunk: 1 });
    expect(getRelayStreamTotalBufferedChunks()).toBe(1);

    addRelayStreamBufferedChunk("r1", { chunk: 2 });
    expect(getRelayStreamTotalBufferedChunks()).toBe(2);
  });

  it("drainRelayStreamBuffer serializes reentrant drains and emits complete once", async () => {
    setRelayStreamFlowCredits("r1", 1);
    addRelayStreamBufferedChunk("r1", {
      stream_id: "stream-r1",
      rows: [{ id: 1 }],
    });
    setRelayStreamPendingComplete("r1", {
      stream_id: "stream-r1",
      total_rows: 1,
    });

    const chunks: unknown[] = [];
    const completes: unknown[] = [];
    const audits: string[] = [];
    const ctx = {
      requestId: "r1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-1",
      conversationId: "conversation-1",
      agentId: "agent-123",
      emitChunk: (frame: unknown) => {
        chunks.push(frame);
      },
      emitComplete: (frame: unknown) => {
        completes.push(frame);
      },
      encodeFrame: async (data: unknown) => data,
      recordAudit: (eventType: string) => {
        audits.push(eventType);
      },
    } as const;

    await Promise.all([drainRelayStreamBuffer(ctx), drainRelayStreamBuffer(ctx)]);

    expect(chunks).toHaveLength(1);
    expect(completes).toHaveLength(1);
    expect(audits).toEqual(["relay:rpc.chunk", "relay:rpc.complete"]);
    expect(getRelayStreamForwardedRows("r1")).toBe(1);
    expect(getRelayStreamPendingComplete("r1")).toBeUndefined();
    expect(getRelayStreamTotalBufferedChunks()).toBe(0);
  });
});
