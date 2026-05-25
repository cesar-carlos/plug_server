import { describe, expect, it } from "vitest";

import {
  resolveStreamChunkOriginalSizeBytes,
  streamChunkMetadataFromPayloadFrame,
} from "../../../../../src/presentation/socket/hub/stream_chunk_metadata";

describe("stream_chunk_metadata", () => {
  it("builds chunk metadata from PayloadFrame envelope sizes", () => {
    expect(
      streamChunkMetadataFromPayloadFrame({
        originalSize: 123,
        compressedSize: 45,
        cmp: "gzip",
      }),
    ).toEqual({
      originalSizeBytes: 123,
      compressedSizeBytes: 45,
      compression: "gzip",
    });
  });

  it("prefers metadata over fallback serialization", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(
      resolveStreamChunkOriginalSizeBytes(
        circular,
        {
          originalSizeBytes: 7,
          compressedSizeBytes: 7,
          compression: "none",
        },
        99,
      ),
    ).toBe(7);
  });

  it("falls back when metadata is missing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(resolveStreamChunkOriginalSizeBytes(circular, undefined, 99)).toBe(99);
  });
});
