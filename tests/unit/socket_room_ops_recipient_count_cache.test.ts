import type { Namespace, Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/infrastructure/redis/adapter/socket_io_redis_adapter", () => ({
  isSocketIoRedisAdapterActive: vi.fn(() => true),
}));

import { isSocketIoRedisAdapterActive } from "../../src/infrastructure/redis/adapter/socket_io_redis_adapter";
import { countSocketsInRoom } from "../../src/socket_room_ops";
import { createSocketServerState } from "../../src/socket_state";
import { env } from "../../src/shared/config/env";

describe("countSocketsInRoom recipient count cache", () => {
  const previousTtl = env.socketCustomEventRecipientCountCacheTtlMs;
  const previousMaxRecipients = env.restSocketEventMaxRecipients;

  beforeEach(() => {
    vi.mocked(isSocketIoRedisAdapterActive).mockReturnValue(true);
    env.socketCustomEventRecipientCountCacheTtlMs = 1_000;
    env.restSocketEventMaxRecipients = 100;
  });

  afterEach(() => {
    env.socketCustomEventRecipientCountCacheTtlMs = previousTtl;
    env.restSocketEventMaxRecipients = previousMaxRecipients;
    vi.clearAllMocks();
  });

  const createNamespace = (roomSize: number, fetchSockets: ReturnType<typeof vi.fn>): Namespace => {
    const rooms = new Map<string, Set<string>>([["room-a", new Set(Array(roomSize).keys())]]);
    return {
      name: "/consumers",
      adapter: { rooms },
      in: () => ({ fetchSockets }),
    } as unknown as Namespace;
  };

  it("serves a second count from cache without calling fetchSockets when TTL > 0", async () => {
    const fetchSockets = vi.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    const namespace = createNamespace(1, fetchSockets);
    const state = createSocketServerState({} as Server, namespace, namespace);

    const first = await countSocketsInRoom(state, namespace, "room-a");
    const second = await countSocketsInRoom(state, namespace, "room-a");

    expect(first.recipients).toBe(2);
    expect(second.recipients).toBe(2);
    expect(fetchSockets).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when captureSockets is true", async () => {
    const fetchSockets = vi.fn().mockResolvedValue([{ id: "s1" }]);
    const namespace = createNamespace(1, fetchSockets);
    const state = createSocketServerState({} as Server, namespace, namespace);

    await countSocketsInRoom(state, namespace, "room-a");
    await countSocketsInRoom(state, namespace, "room-a", { captureSockets: true });

    expect(fetchSockets).toHaveBeenCalledTimes(2);
  });

  it("does not cache when TTL is 0", async () => {
    env.socketCustomEventRecipientCountCacheTtlMs = 0;
    const fetchSockets = vi.fn().mockResolvedValue([{ id: "s1" }]);
    const namespace = createNamespace(1, fetchSockets);
    const state = createSocketServerState({} as Server, namespace, namespace);

    await countSocketsInRoom(state, namespace, "room-a");
    await countSocketsInRoom(state, namespace, "room-a");

    expect(fetchSockets).toHaveBeenCalledTimes(2);
  });
});
