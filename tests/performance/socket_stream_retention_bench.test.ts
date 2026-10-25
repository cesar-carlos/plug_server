import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  addRelayStreamBufferedChunk,
  drainRelayStreamBuffer,
  getRelayStreamBufferedBytes,
  getRelayStreamFlowEntry,
  resetRelayStreamFlowState,
  setRelayStreamFlowCredits,
} from "../../src/presentation/socket/hub/relay/relay_stream_flow_state";

afterEach(resetRelayStreamFlowState);

it("measures retained frame bytes after a consumer pauses before queue compaction", async () => {
  // Stay below the half-full compaction boundary: a slow consumer can pause here indefinitely.
  const chunks = 256;
  const drained = 96;
  const decodedBytes = 128 * 1024;
  const wireBytes = 32 * 1024;
  const samples: { retainedBytes: number; obsoleteBytes: number; drainMs: number }[] = [];
  for (let repeat = 0; repeat < 9; repeat += 1) {
    resetRelayStreamFlowState();
    for (let i = 0; i < chunks; i += 1) {
      addRelayStreamBufferedChunk("bench", { rows: [{ id: i }] }, decodedBytes, {
        bytes: Buffer.alloc(decodedBytes, i),
        wireBytes: Buffer.alloc(wireBytes, i),
        cmp: "gzip",
        originalSize: decodedBytes,
      });
    }
    setRelayStreamFlowCredits("bench", chunks);
    let emitted = 0;
    const start = performance.now();
    const result = await drainRelayStreamBuffer({
      requestId: "bench",
      consumerSocketId: "consumer",
      agentSocketId: "agent-socket",
      conversationId: "conversation",
      agentId: "agent",
      canEmitChunk: () => emitted < drained,
      encodeFrame: async () => {
        throw new Error("Expected byte forwarding");
      },
      encodeFrameFromBytes: async (raw) => raw.wireBytes,
      emitChunk: () => {
        emitted += 1;
        return true;
      },
      emitComplete: () => {
        throw new Error("Unexpected completion");
      },
      recordAudit: () => {},
    });
    const drainMs = performance.now() - start;
    expect(result.chunksDrained).toBe(drained);
    expect(result.pausedForBackpressure).toBe(true);
    expect(getRelayStreamBufferedBytes("bench")).toBe((chunks - drained) * decodedBytes);
    const entry = getRelayStreamFlowEntry("bench")!;
    let retainedBytes = 0;
    let obsoleteBytes = 0;
    entry.bufferedChunkRawForward.forEach((raw, index) => {
      const bytes = (raw?.bytes.byteLength ?? 0) + (raw?.wireBytes?.byteLength ?? 0);
      retainedBytes += bytes;
      if (index < entry.bufferedChunkHead) obsoleteBytes += bytes;
    });
    expect(retainedBytes - obsoleteBytes).toBe((chunks - drained) * (decodedBytes + wireBytes));
    expect(obsoleteBytes, "Delivered frame buffers must not remain reachable from the queue").toBe(
      0,
    );
    if (repeat >= 2) samples.push({ retainedBytes, obsoleteBytes, drainMs });
  }
  const output = process.env.SOCKET_STREAM_RETENTION_REPORT ?? "tmp/socket-stream-retention.json";
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        nodeVersion: process.version,
        platform: process.platform,
        chunks,
        drained,
        decodedBytes,
        wireBytes,
        measurement: "Buffer bytes reachable from the queue; excludes allocator/RSS overhead",
        samples,
      },
      null,
      2,
    ),
  );
});
