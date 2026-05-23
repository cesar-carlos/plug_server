import { describe, expect, it } from "vitest";

import {
  releaseCustomPublishInflightSlot,
  releaseSocketInflightSlot,
  tryAcquireCustomPublishInflightSlot,
  tryAcquireSocketInflightSlot,
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
    expect((socket.data.inflightCounter?.inflightCount ?? 0)).toBe(0);
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
