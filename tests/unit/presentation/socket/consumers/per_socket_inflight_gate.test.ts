import { describe, expect, it } from "vitest";

import {
  releaseCustomPublishInflightSlot,
  releaseSocketInflightSlot,
  releaseSocketInflightSlots,
  tryAcquireCustomPublishInflightSlot,
  tryAcquireSocketInflightSlot,
  tryAcquireSocketInflightSlots,
  type SocketWithCustomPublishInflight,
  type SocketWithInflightCounter,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";

const buildInflightSocket = (): SocketWithInflightCounter =>
  ({
    data: {},
  }) as unknown as SocketWithInflightCounter;

const buildCustomPublishSocket = (): SocketWithCustomPublishInflight =>
  ({
    data: {},
  }) as unknown as SocketWithCustomPublishInflight;

describe("per_socket_inflight_gate", () => {
  it("should allow unlimited slots when max is 0", () => {
    const socket = buildInflightSocket();
    expect(tryAcquireSocketInflightSlot(socket, 0)).toBe(true);
    expect(tryAcquireSocketInflightSlot(socket, 0)).toBe(true);
    releaseSocketInflightSlot(socket);
    expect(socket.data.inflightCounter?.inflightCount ?? 0).toBe(0);
  });

  it("should reject when shared inflight cap is reached", () => {
    const socket = buildInflightSocket();
    expect(tryAcquireSocketInflightSlot(socket, 1)).toBe(true);
    expect(tryAcquireSocketInflightSlot(socket, 1)).toBe(false);
    releaseSocketInflightSlot(socket);
    expect(tryAcquireSocketInflightSlot(socket, 1)).toBe(true);
    releaseSocketInflightSlot(socket);
  });

  it("should release shared inflight idempotently from finally blocks", () => {
    const socket = buildInflightSocket();
    releaseSocketInflightSlot(socket);
    releaseSocketInflightSlot(socket);
    expect(socket.data.inflightCounter).toBeUndefined();
  });

  describe("tryAcquireSocketInflightSlots (atomic batch acquire)", () => {
    it("acquires N slots atomically when capacity is sufficient", () => {
      const socket = buildInflightSocket();
      const result = tryAcquireSocketInflightSlots(socket, 3, 10);
      expect(result.ok).toBe(true);
      expect(result.requestedSlots).toBe(3);
      expect(socket.data.inflightCounter?.inflightCount).toBe(3);
    });

    it("rejects all-or-nothing when capacity is insufficient", () => {
      const socket = buildInflightSocket();
      // Pre-fill 3 of 5 slots.
      tryAcquireSocketInflightSlots(socket, 3, 5);
      // Try to take 3 more — only 2 free, so all-or-nothing rejects.
      const result = tryAcquireSocketInflightSlots(socket, 3, 5);
      expect(result.ok).toBe(false);
      expect(result.availableSlots).toBe(2);
      expect(result.requestedSlots).toBe(3);
      // No slots were acquired on the rejected call.
      expect(socket.data.inflightCounter?.inflightCount).toBe(3);
    });

    it("treats max <= 0 as disabled (always succeeds without bookkeeping)", () => {
      const socket = buildInflightSocket();
      const result = tryAcquireSocketInflightSlots(socket, 100, 0);
      expect(result.ok).toBe(true);
      expect(socket.data.inflightCounter).toBeUndefined();
    });

    it("treats count <= 0 as no-op", () => {
      const socket = buildInflightSocket();
      const result = tryAcquireSocketInflightSlots(socket, 0, 5);
      expect(result.ok).toBe(true);
      expect(socket.data.inflightCounter).toBeUndefined();
    });

    it("releaseSocketInflightSlots decrements by exact count", () => {
      const socket = buildInflightSocket();
      tryAcquireSocketInflightSlots(socket, 4, 10);
      releaseSocketInflightSlots(socket, 3);
      expect(socket.data.inflightCounter?.inflightCount).toBe(1);
      releaseSocketInflightSlots(socket, 1);
      expect(socket.data.inflightCounter?.inflightCount).toBe(0);
    });

    it("releaseSocketInflightSlots is idempotent below zero", () => {
      const socket = buildInflightSocket();
      releaseSocketInflightSlots(socket, 5); // no context, no-op
      tryAcquireSocketInflightSlots(socket, 2, 10);
      releaseSocketInflightSlots(socket, 10); // floored at 0
      expect(socket.data.inflightCounter?.inflightCount).toBe(0);
    });
  });

  it("should keep custom publish inflight independent from shared inflight", () => {
    const shared = buildInflightSocket();
    const publish = buildCustomPublishSocket() as SocketWithInflightCounter &
      SocketWithCustomPublishInflight;

    expect(tryAcquireSocketInflightSlot(shared, 1)).toBe(true);
    expect(tryAcquireCustomPublishInflightSlot(publish, 1)).toBe(true);
    expect(tryAcquireCustomPublishInflightSlot(publish, 1)).toBe(false);
    expect(tryAcquireSocketInflightSlot(shared, 1)).toBe(false);

    releaseCustomPublishInflightSlot(publish);
    releaseSocketInflightSlot(shared);
  });
});
