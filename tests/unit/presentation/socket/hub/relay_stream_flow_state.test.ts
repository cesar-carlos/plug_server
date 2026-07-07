import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";

import {
  clearRelayStreamFlowState,
  resetRelayStreamFlowState,
  addRelayStreamBufferedChunk,
  getRelayStreamBufferedChunks,
  getRelayStreamTotalBufferedChunks,
  getRelayStreamBufferedBytes,
  getRelayStreamTotalBufferedBytes,
  setRelayStreamFlowCredits,
  addRelayStreamFlowCredits,
  getRelayStreamFlowCredits,
  setRelayStreamPendingComplete,
  getRelayStreamPendingComplete,
  addRelayStreamForwardedRows,
  drainRelayStreamBuffer,
  getRelayStreamForwardedRows,
  getRelayStreamBufferedChunkCount,
} from "../../../../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(() => {
  resetRelayStreamFlowState();
});

describe("relay_stream_flow_state", () => {
  it("clearRelayStreamFlowState subtracts buffered length from total", () => {
    addRelayStreamBufferedChunk("r1", { a: 1 }, 10);
    addRelayStreamBufferedChunk("r1", { b: 2 }, 20);

    clearRelayStreamFlowState("r1");

    expect(getRelayStreamBufferedChunks("r1").length).toBe(0);
    expect(getRelayStreamBufferedBytes("r1")).toBe(0);
    expect(getRelayStreamTotalBufferedChunks()).toBe(0);
    expect(getRelayStreamTotalBufferedBytes()).toBe(0);
  });

  it("resetRelayStreamFlowState clears maps and total", () => {
    setRelayStreamFlowCredits("r1", 3);
    setRelayStreamPendingComplete("r1", {});
    addRelayStreamForwardedRows("r1", 7);
    addRelayStreamBufferedChunk("r2", {}, 12);

    resetRelayStreamFlowState();

    expect(getRelayStreamFlowCredits("r1")).toBe(0);
    expect(getRelayStreamPendingComplete("r1")).toBeUndefined();
    expect(getRelayStreamForwardedRows("r1")).toBe(0);
    expect(getRelayStreamTotalBufferedChunks()).toBe(0);
    expect(getRelayStreamTotalBufferedBytes()).toBe(0);
  });

  it("addRelayStreamFlowCredits increases credits up to hub max window", () => {
    const maxWindow = env.socketRestStreamPullMaxWindowSize;
    addRelayStreamFlowCredits("r-cap", maxWindow);
    expect(getRelayStreamFlowCredits("r-cap")).toBe(maxWindow);
    addRelayStreamFlowCredits("r-cap", 10);
    expect(getRelayStreamFlowCredits("r-cap")).toBe(maxWindow);
  });

  it("addRelayStreamFlowCredits increases credits", () => {
    setRelayStreamFlowCredits("r1", 5);
    expect(getRelayStreamFlowCredits("r1")).toBe(5);

    addRelayStreamFlowCredits("r1", 5);
    expect(getRelayStreamFlowCredits("r1")).toBe(10);
  });

  it("addRelayStreamBufferedChunk increments total chunk and byte counters", () => {
    addRelayStreamBufferedChunk("r1", { chunk: 1 }, 15);
    expect(getRelayStreamTotalBufferedChunks()).toBe(1);
    expect(getRelayStreamBufferedBytes("r1")).toBe(15);
    expect(getRelayStreamTotalBufferedBytes()).toBe(15);

    addRelayStreamBufferedChunk("r1", { chunk: 2 }, 20);
    expect(getRelayStreamTotalBufferedChunks()).toBe(2);
    expect(getRelayStreamBufferedBytes("r1")).toBe(35);
    expect(getRelayStreamTotalBufferedBytes()).toBe(35);
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
        return true;
      },
      emitComplete: (frame: unknown) => {
        completes.push(frame);
        return true;
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

  it("keeps buffered chunk and credits when chunk encoding fails", async () => {
    setRelayStreamFlowCredits("r1", 1);
    addRelayStreamBufferedChunk("r1", {
      stream_id: "stream-r1",
      rows: [{ id: 1 }],
    });

    const ctx = {
      requestId: "r1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-1",
      conversationId: "conversation-1",
      agentId: "agent-123",
      emitChunk: () => true,
      emitComplete: () => true,
      encodeFrame: async () => {
        throw new Error("encode failed");
      },
      recordAudit: () => {},
    } as const;

    await expect(drainRelayStreamBuffer(ctx)).rejects.toThrow("encode failed");

    expect(getRelayStreamBufferedChunkCount("r1")).toBe(1);
    expect(getRelayStreamTotalBufferedChunks()).toBe(1);
    expect(getRelayStreamFlowCredits("r1")).toBe(1);
    expect(getRelayStreamForwardedRows("r1")).toBe(0);
  });

  it("does not emit buffered data after the drain context becomes inactive", async () => {
    setRelayStreamFlowCredits("r1", 1);
    addRelayStreamBufferedChunk("r1", {
      stream_id: "stream-r1",
      rows: [{ id: 1 }],
    });

    let active = true;
    let encodeStarted = false;
    let resolveEncode: ((value: unknown) => void) | undefined;
    const encodePromise = new Promise<unknown>((resolve) => {
      resolveEncode = resolve;
    });

    const chunks: unknown[] = [];
    const ctx = {
      requestId: "r1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-1",
      conversationId: "conversation-1",
      agentId: "agent-123",
      emitChunk: (frame: unknown) => {
        chunks.push(frame);
      },
      emitComplete: () => {},
      encodeFrame: async () => {
        encodeStarted = true;
        return encodePromise;
      },
      recordAudit: () => {},
      isActive: () => active,
    } as const;

    const drain = drainRelayStreamBuffer(ctx);
    await vi.waitFor(() => expect(encodeStarted).toBe(true));

    active = false;
    clearRelayStreamFlowState("r1");
    resolveEncode?.({ framed: true });

    await drain;

    expect(chunks).toHaveLength(0);
    expect(getRelayStreamTotalBufferedChunks()).toBe(0);
    expect(getRelayStreamTotalBufferedBytes()).toBe(0);
  });
});
