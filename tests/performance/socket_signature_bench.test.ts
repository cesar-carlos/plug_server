import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../../src/shared/config/env", () => ({
  env: {
    payloadSignOutbound: true,
    payloadSigningKey: "benchmark-only-not-a-deployment-key",
    payloadSigningKeyId: "benchmark",
  },
}));

import {
  encodePayloadFrameFromPreencodedWire,
  _resetSignatureInputCacheForTests,
} from "../../src/shared/utils/payload_frame";

it("measures signed frame construction with cache misses and verifies canonical HMAC bytes", () => {
  const results: { bytes: number; iterations: number; samplesMs: number[]; medianMs: number }[] =
    [];
  for (const bytes of [1024, 64 * 1024, 256 * 1024, 1024 * 1024]) {
    const wireBytes = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 1) wireBytes[i] = i % 256;
    const iterations = bytes <= 65536 ? 300 : 60;
    const samplesMs: number[] = [];
    for (let repeat = 0; repeat < 9; repeat += 1) {
      _resetSignatureInputCacheForTests();
      let lastFrame: ReturnType<typeof encodePayloadFrameFromPreencodedWire> | undefined;
      const start = performance.now();
      for (let i = 0; i < iterations; i += 1) {
        lastFrame = encodePayloadFrameFromPreencodedWire(
          { originalSize: bytes, wireBytes, cmp: "none" },
          { requestId: `request-${i}`, omitTraceId: true },
        );
      }
      const elapsed = performance.now() - start;
      if (repeat >= 2) samplesMs.push(elapsed);
      const expected = createHmac("sha256", "benchmark-only-not-a-deployment-key")
        .update(
          JSON.stringify({
            cmp: "none",
            compressedSize: bytes,
            contentType: "application/json",
            enc: "json",
            originalSize: bytes,
            payload: wireBytes.toString("base64"),
            requestId: `request-${iterations - 1}`,
            schemaVersion: lastFrame!.schemaVersion,
            traceId: null,
          }),
        )
        .digest("base64");
      expect(lastFrame!.signature?.value).toBe(expected);
    }
    results.push({
      bytes,
      iterations,
      samplesMs,
      medianMs: [...samplesMs].sort((a, b) => a - b)[3]!,
    });
  }
  const output = process.env.SOCKET_SIGNATURE_BENCH_REPORT ?? "tmp/socket-signature-bench.json";
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify({ nodeVersion: process.version, platform: process.platform, results }, null, 2),
  );
  _resetSignatureInputCacheForTests();
});
