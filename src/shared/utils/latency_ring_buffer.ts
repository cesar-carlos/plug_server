/**
 * Fixed-capacity ring buffer for latency samples (O(1) push, no front splice).
 */

export interface LatencyRingBuffer {
  readonly capacity: number;
  samples: number[];
  next: number;
  filled: number;
}

export const createLatencyRingBuffer = (capacity: number): LatencyRingBuffer => ({
  capacity,
  samples: new Array(capacity).fill(0),
  next: 0,
  filled: 0,
});

export const pushLatencyRingBuffer = (ring: LatencyRingBuffer, value: number): void => {
  ring.samples[ring.next] = value;
  ring.next = (ring.next + 1) % ring.capacity;
  ring.filled = Math.min(ring.capacity, ring.filled + 1);
};

/** Chronological order (oldest first) for percentile computation. */
export const latencyRingBufferValues = (ring: LatencyRingBuffer): number[] => {
  if (ring.filled === 0) {
    return [];
  }
  if (ring.filled < ring.capacity) {
    return ring.samples.slice(0, ring.filled);
  }
  const out: number[] = [];
  for (let i = 0; i < ring.capacity; i++) {
    out.push(ring.samples[(ring.next + i) % ring.capacity]!);
  }
  return out;
};
