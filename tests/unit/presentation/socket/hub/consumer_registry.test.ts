import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumerRegistry } from "../../../../../src/presentation/socket/hub/consumer_registry";

describe("consumer_registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    consumerRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    consumerRegistry.clear();
  });

  it("registers and removes consumer sessions by socket id", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    const registered = consumerRegistry.registerSession({
      socketId: "sock-1",
      userId: "user-1",
      principalType: "user",
    });

    expect(registered).toEqual({
      socketId: "sock-1",
      userId: "user-1",
      principalType: "user",
      connectedAt: "2026-05-08T10:00:00.000Z",
      lastSeenAt: "2026-05-08T10:00:00.000Z",
    });

    const removed = consumerRegistry.removeBySocketId("sock-1");
    expect(removed?.socketId).toBe("sock-1");
    expect(consumerRegistry.removeBySocketId("sock-1")).toBeNull();
  });

  it("touch refreshes lastSeenAt for idle detection", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    consumerRegistry.registerSession({
      socketId: "sock-idle",
      userId: "user-1",
      principalType: "user",
    });
    consumerRegistry.registerSession({
      socketId: "sock-active",
      userId: "user-2",
      principalType: "client",
    });

    vi.setSystemTime(new Date("2026-05-08T10:02:00.000Z"));
    consumerRegistry.touch("sock-active");

    const idle = consumerRegistry.listIdle(60_000);
    expect(idle.map((consumer) => consumer.socketId)).toEqual(["sock-idle"]);
  });
});
