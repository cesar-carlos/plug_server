import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SocketRedisModule from "../../../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis";

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
    readonly eval: ReturnType<typeof vi.fn>;
  };
  readonly envMock: {
    socketRateLimitRedisUrl: string;
  };
  readonly createClientMock: ReturnType<typeof vi.fn>;
  readonly module: typeof SocketRedisModule;
}> => {
  vi.resetModules();

  const client: {
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    incrBy: ReturnType<typeof vi.fn>;
    pExpire: ReturnType<typeof vi.fn>;
    pTTL: ReturnType<typeof vi.fn>;
    decrBy: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    evalSha: ReturnType<typeof vi.fn>;
    scriptLoad: ReturnType<typeof vi.fn>;
  } = {
    on: vi.fn(() => client),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    incrBy: vi.fn(),
    pExpire: vi.fn().mockResolvedValue(true),
    pTTL: vi.fn().mockResolvedValue(10_000),
    decrBy: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn(),
    evalSha: vi.fn(),
    scriptLoad: vi.fn().mockImplementation(async (source: string) => {
      // Distinguish the three pre-loaded scripts by their unique keywords so
      // tests can assert which SHA is invoked without depending on call order.
      if (typeof source === "string") {
        if (/maxAllowed/.test(source)) {
          return "sha-consume-or-rollback";
        }
        if (/DECRBY/.test(source)) {
          return "sha-refund";
        }
      }
      return "sha-consume";
    }),
  };
  const envMock = {
    socketRateLimitRedisUrl: "redis://localhost:6379",
    redisDefaultConnectTimeoutMs: 5_000,
    redisTenantId: "",
    redisDefaultReconnectBaseMs: 200,
    redisDefaultReconnectMaxMs: 5_000,
  };
  const createClientMock = vi.fn(() => client);

  vi.doMock("../../../../src/shared/config/env", () => ({ env: envMock }));
  vi.doMock("redis", () => ({ createClient: createClientMock }));

  const module = await import("../../../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis");
  return { client, envMock, createClientMock, module };
};

describe("socket_rate_limit_redis", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
  });

  it("consumes Redis budget via cached Lua EVALSHA and returns remaining credits", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.evalSha.mockResolvedValue([1, 3]);

    await initSocketRateLimitRedis();
    const decision = await consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key: "user:abc",
      windowMs: 10_000,
      max: 5,
      cost: 3,
    });

    expect(decision).toEqual({ allowed: true, remaining: 2, limit: 5, used: 3 });
    /**
     * Three scripts pre-loaded: consume (legacy, kept for compat),
     * consume_or_rollback (new hot path), refund (external rollback).
     */
    expect(client.scriptLoad).toHaveBeenCalledTimes(3);
    expect(client.evalSha).toHaveBeenCalledTimes(1);
    expect(client.evalSha).toHaveBeenCalledWith(
      "sha-consume-or-rollback",
      expect.objectContaining({
        keys: ["plug_socket_rl:{plug}:relay_rpc_request:user:abc"],
        arguments: ["3", "10000", "5"],
      }),
    );
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.incrBy).not.toHaveBeenCalled();
    expect(client.pExpire).not.toHaveBeenCalled();

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
    client.evalSha.mockRejectedValue(new Error("command failed"));

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
    // 3 failed consume attempts via cached Lua EVALSHA; the 4th is short-circuited.
    expect(client.evalSha).toHaveBeenCalledTimes(3);

    await closeSocketRateLimitRedis();
  });

  it("refunds consumed Redis credits with a single atomic EVALSHA", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, refundSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.evalSha.mockResolvedValue(0);

    await initSocketRateLimitRedis();
    await refundSocketRateLimitRedis({
      scope: "relay_stream_pull_credits",
      key: "user:abc",
      cost: 4,
    });

    expect(client.evalSha).toHaveBeenCalledTimes(1);
    expect(client.evalSha).toHaveBeenCalledWith(
      "sha-refund",
      expect.objectContaining({
        keys: ["plug_socket_rl:{plug}:relay_stream_pull_credits:user:abc"],
        arguments: ["4"],
      }),
    );
    expect(client.decrBy).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();

    await closeSocketRateLimitRedis();
  });

  it("retries refund once after Redis transient failure", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, refundSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.evalSha.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(0);

    await initSocketRateLimitRedis();
    vi.useFakeTimers();
    const refundPromise = refundSocketRateLimitRedis({
      scope: "client_socket_event_publish",
      key: "client:test",
      cost: 1,
    });
    await vi.advanceTimersByTimeAsync(50);
    await refundPromise;
    vi.useRealTimers();

    expect(client.evalSha).toHaveBeenCalledTimes(2);

    await closeSocketRateLimitRedis();
  });
  it("rolls back Redis increment atomically when budget is exceeded (single EVALSHA on deny)", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    // The new consume_or_rollback Lua returns {0, used} (post-DECRBY=2) in a
    // single EVALSHA — no second round-trip on deny.
    client.evalSha.mockResolvedValueOnce([0, 2]);

    await initSocketRateLimitRedis();
    const decision = await consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key: "user:abc",
      windowMs: 10_000,
      max: 2,
    });

    expect(decision).toEqual({ allowed: false, remaining: 0, limit: 2, used: 2 });
    expect(client.evalSha).toHaveBeenCalledTimes(1);
    expect(client.evalSha).toHaveBeenCalledWith(
      "sha-consume-or-rollback",
      expect.objectContaining({
        keys: ["plug_socket_rl:{plug}:relay_rpc_request:user:abc"],
        arguments: ["1", "10000", "2"],
      }),
    );

    await closeSocketRateLimitRedis();
  });

  it("returns null on malformed Lua reply (defensive fail-open)", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    // Bogus reply (single number instead of [allowed, used]).
    client.evalSha.mockResolvedValueOnce(99);

    await initSocketRateLimitRedis();
    const decision = await consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key: "user:weird",
      windowMs: 10_000,
      max: 5,
    });

    expect(decision).toBeNull();
    expect(client.evalSha).toHaveBeenCalledTimes(1);

    await closeSocketRateLimitRedis();
  });

  it("at boundary used==max, decision is allowed and saturation is observed", async () => {
    const {
      client,
      module: { closeSocketRateLimitRedis, consumeSocketRateLimitRedis, initSocketRateLimitRedis },
    } = await setupSocketRedisModule();
    client.evalSha.mockResolvedValueOnce([1, 5]);

    await initSocketRateLimitRedis();
    const decision = await consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key: "user:saturated",
      windowMs: 10_000,
      max: 5,
    });

    expect(decision).toEqual({ allowed: true, remaining: 0, limit: 5, used: 5 });
    expect(client.evalSha).toHaveBeenCalledTimes(1);

    await closeSocketRateLimitRedis();
  });
});
