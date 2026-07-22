import type * as EnvModule from "../../../../../src/shared/config/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consumeSocketRateLimitRedisMock = vi.fn();

vi.mock("../../../../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis", () => ({
  consumeSocketRateLimitRedis: (...args: unknown[]) => consumeSocketRateLimitRedisMock(...args),
  refundSocketRateLimitRedis: vi.fn(),
}));

vi.mock("../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketRelayRateLimitWindowMs: 10_000,
      socketRelayRateLimitMaxConversationStarts: 8,
      socketRelayRateLimitMaxRequests: 4,
      socketRelayRateLimitMaxStreamPullCredits: 1000,
      socketAgentsStreamPullRateLimitMaxCredits: 48,
      socketRateLimitRedisUrl: "redis://127.0.0.1:6379",
      socketRateLimitRedisLocalFirst: false,
    },
  };
});

import { env } from "../../../../../src/shared/config/env";
import {
  allowRelayRpcRequestAsync,
  getRelayRateLimitMetricsSnapshot,
  resetRelayRateLimiterState,
} from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";

describe("consumer_relay_rate_limiter allowRelayRpcRequestAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRelayRateLimiterState();
    env.socketRateLimitRedisUrl = "redis://127.0.0.1:6379";
    env.socketRateLimitRedisLocalFirst = false;
    env.socketRelayRateLimitMaxRequests = 4;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should await Redis on the legacy path when local-first is disabled", async () => {
    consumeSocketRateLimitRedisMock.mockResolvedValue({
      allowed: true,
      remaining: 3,
      limit: 4,
      used: 1,
    });

    const allowed = await allowRelayRpcRequestAsync("user-async", "sock-1");

    expect(allowed).toBe(true);
    expect(consumeSocketRateLimitRedisMock).toHaveBeenCalledTimes(1);
    const snapshot = getRelayRateLimitMetricsSnapshot();
    expect(snapshot.counters.relayRequestAllowedUser).toBe(1);
  });

  it("should skip Redis RTT on local deny when local-first is enabled", async () => {
    env.socketRateLimitRedisLocalFirst = true;

    for (let index = 0; index < env.socketRelayRateLimitMaxRequests; index += 1) {
      const allowed = await allowRelayRpcRequestAsync("user-local-first", "sock-2");
      expect(allowed).toBe(true);
    }

    consumeSocketRateLimitRedisMock.mockClear();
    const denied = await allowRelayRpcRequestAsync("user-local-first", "sock-2");
    expect(denied).toBe(false);
    expect(consumeSocketRateLimitRedisMock).not.toHaveBeenCalled();
  });

  it("should reconcile local allow with Redis asynchronously when local-first is enabled", async () => {
    vi.useFakeTimers();
    env.socketRateLimitRedisLocalFirst = true;

    let resolveRedis!: (value: { allowed: boolean; remaining: number; limit: number; used: number }) => void;
    consumeSocketRateLimitRedisMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRedis = resolve;
        }),
    );

    const allowedPromise = allowRelayRpcRequestAsync("user-reconcile", "sock-3");
    await Promise.resolve();
    expect(consumeSocketRateLimitRedisMock).toHaveBeenCalledTimes(1);

    const allowed = await allowedPromise;
    expect(allowed).toBe(true);

    resolveRedis({ allowed: false, remaining: 0, limit: 4, used: 4 });
    await vi.runAllTimersAsync();

    const afterRefund = await allowRelayRpcRequestAsync("user-reconcile", "sock-3");
    expect(afterRefund).toBe(true);
  });
});
