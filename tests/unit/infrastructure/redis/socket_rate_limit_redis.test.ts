import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SocketRedisModule from "../../../../src/infrastructure/redis/socket_rate_limit_redis";

const setupSocketRedisModule = async (): Promise<{
  readonly client: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    readonly incrBy: ReturnType<typeof vi.fn>;
    readonly pExpire: ReturnType<typeof vi.fn>;
    readonly pTTL: ReturnType<typeof vi.fn>;
    readonly decrBy: ReturnType<typeof vi.fn>;
    readonly del: ReturnType<typeof vi.fn>;
  };
  readonly envMock: {
    socketRateLimitRedisUrl: string;
  };
  readonly createClientMock: ReturnType<typeof vi.fn>;
  readonly module: typeof SocketRedisModule;
}> => {
  vi.resetModules();

  const client = {
    on: vi.fn(() => client),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    incrBy: vi.fn(),
    pExpire: vi.fn().mockResolvedValue(true),
    pTTL: vi.fn().mockResolvedValue(10_000),
    decrBy: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
  };
  const envMock = {
    socketRateLimitRedisUrl: "redis://localhost:6379",
  };
  const createClientMock = vi.fn(() => client);

  vi.doMock("../../../../src/shared/config/env", () => ({ env: envMock }));
  vi.doMock("redis", () => ({ createClient: createClientMock }));

  const module = await import("../../../../src/infrastructure/redis/socket_rate_limit_redis");
  return { client, envMock, createClientMock, module };
};

describe("socket_rate_limit_redis", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
  });

  it("consumes Redis budget and returns remaining credits", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.incrBy.mockResolvedValue(3);

    await initSocketRateLimitRedis();
    const decision = await consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key: "user:abc",
      windowMs: 10_000,
      max: 5,
      cost: 3,
    });

    expect(decision).toEqual({ allowed: true, remaining: 2, limit: 5, used: 3 });
    expect(client.incrBy).toHaveBeenCalledWith("plug_socket_rl:relay_rpc_request:user:abc", 3);
    expect(client.pExpire).toHaveBeenCalledWith(
      "plug_socket_rl:relay_rpc_request:user:abc",
      10_000,
    );

    await closeSocketRateLimitRedis();
  });

  it("falls back to memory when Redis connect fails", async () => {
    const {
      client,
      module: { consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.connect.mockRejectedValue(new Error("redis unavailable"));

    await initSocketRateLimitRedis();
    await expect(
      consumeSocketRateLimitRedis({
        scope: "agents_command",
        key: "user:abc",
        windowMs: 10_000,
        max: 1,
      }),
    ).resolves.toBeNull();
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it("opens a short circuit after repeated command failures", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.incrBy.mockRejectedValue(new Error("command failed"));

    await initSocketRateLimitRedis();
    for (let index = 0; index < 3; index += 1) {
      await expect(
        consumeSocketRateLimitRedis({
          scope: "relay_rpc_request",
          key: `user:${index}`,
          windowMs: 10_000,
          max: 5,
        }),
      ).resolves.toBeNull();
    }

    await expect(
      consumeSocketRateLimitRedis({
        scope: "relay_rpc_request",
        key: "user:circuit",
        windowMs: 10_000,
        max: 5,
      }),
    ).resolves.toBeNull();
    expect(client.incrBy).toHaveBeenCalledTimes(3);

    await closeSocketRateLimitRedis();
  });

  it("refunds consumed Redis credits and deletes empty buckets", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, refundSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.decrBy.mockResolvedValue(0);

    await initSocketRateLimitRedis();
    await refundSocketRateLimitRedis({
      scope: "relay_stream_pull_credits",
      key: "user:abc",
      cost: 4,
    });

    expect(client.decrBy).toHaveBeenCalledWith(
      "plug_socket_rl:relay_stream_pull_credits:user:abc",
      4,
    );
    expect(client.del).toHaveBeenCalledWith("plug_socket_rl:relay_stream_pull_credits:user:abc");

    await closeSocketRateLimitRedis();
  });
});
