import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as RedisClientOptionsModuleNs from "../../../../src/infrastructure/redis/connection/redis_client_options";

type RedisClientOptionsModule = typeof RedisClientOptionsModuleNs;

const setupHelper = async (envOverrides?: {
  readonly redisDefaultConnectTimeoutMs?: number;
  readonly redisDefaultReconnectBaseMs?: number;
  readonly redisDefaultReconnectMaxMs?: number;
}): Promise<RedisClientOptionsModule> => {
  vi.resetModules();
  vi.doMock("../../../../src/shared/config/env", () => ({
    env: {
      redisDefaultConnectTimeoutMs: envOverrides?.redisDefaultConnectTimeoutMs ?? 5_000,
      redisDefaultReconnectBaseMs: envOverrides?.redisDefaultReconnectBaseMs ?? 200,
      redisDefaultReconnectMaxMs: envOverrides?.redisDefaultReconnectMaxMs ?? 5_000,
    },
  }));
  return await import("../../../../src/infrastructure/redis/connection/redis_client_options");
};

describe("buildResilientRedisClientOptions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
  });

  it("uses env defaults when overrides are not provided", async () => {
    const { buildResilientRedisClientOptions } = await setupHelper({
      redisDefaultConnectTimeoutMs: 7_500,
      redisDefaultReconnectBaseMs: 100,
      redisDefaultReconnectMaxMs: 4_000,
    });
    const options = buildResilientRedisClientOptions({ url: "redis://localhost:6379" });
    expect(options.url).toBe("redis://localhost:6379");
    expect(options.RESP).toBe(2);
    expect(options.socket).toBeDefined();
    expect(typeof options.socket).toBe("object");
    const socket = options.socket as { readonly connectTimeout: number };
    expect(socket.connectTimeout).toBe(7_500);
  });

  it("prefers explicit overrides over env defaults", async () => {
    const { buildResilientRedisClientOptions } = await setupHelper();
    const options = buildResilientRedisClientOptions({
      url: "redis://localhost:6379",
      connectTimeoutMs: 1_234,
      reconnectBaseMs: 50,
      reconnectMaxMs: 1_000,
    });
    const socket = options.socket as { readonly connectTimeout: number };
    expect(socket.connectTimeout).toBe(1_234);
  });

  it("backoff grows exponentially and is capped at the configured maximum", async () => {
    const { buildResilientRedisClientOptions } = await setupHelper();
    const options = buildResilientRedisClientOptions({
      url: "redis://x",
      reconnectBaseMs: 100,
      reconnectMaxMs: 2_000,
    });
    const socket = options.socket as {
      readonly reconnectStrategy: (retries: number) => number;
    };
    const strategy = socket.reconnectStrategy;
    expect(strategy(0)).toBe(100);
    expect(strategy(1)).toBe(200);
    expect(strategy(2)).toBe(400);
    expect(strategy(3)).toBe(800);
    expect(strategy(4)).toBe(1_600);
    expect(strategy(5)).toBe(2_000);
    expect(strategy(50)).toBe(2_000);
  });

  it("never overflows the retry exponent regardless of how many retries pile up", async () => {
    const { buildResilientRedisClientOptions } = await setupHelper();
    const options = buildResilientRedisClientOptions({
      url: "redis://x",
      reconnectBaseMs: 1,
      reconnectMaxMs: 10_000,
    });
    const socket = options.socket as {
      readonly reconnectStrategy: (retries: number) => number;
    };
    expect(socket.reconnectStrategy(1_000_000)).toBeLessThanOrEqual(10_000);
    expect(socket.reconnectStrategy(1_000_000)).toBeGreaterThan(0);
  });
});
