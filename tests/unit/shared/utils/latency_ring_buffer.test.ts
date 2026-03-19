import { describe, expect, it } from "vitest";

import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
} from "../../../../src/shared/utils/latency_ring_buffer";

describe("latency_ring_buffer", () => {
  it("should preserve order when not full", () => {
    const ring = createLatencyRingBuffer(4);
    pushLatencyRingBuffer(ring, 1);
    pushLatencyRingBuffer(ring, 2);
    expect(latencyRingBufferValues(ring)).toEqual([1, 2]);
  });

  it("should overwrite oldest when full", () => {
    const ring = createLatencyRingBuffer(3);
    pushLatencyRingBuffer(ring, 1);
    pushLatencyRingBuffer(ring, 2);
    pushLatencyRingBuffer(ring, 3);
    pushLatencyRingBuffer(ring, 4);
    expect(latencyRingBufferValues(ring)).toEqual([2, 3, 4]);
  });
});
