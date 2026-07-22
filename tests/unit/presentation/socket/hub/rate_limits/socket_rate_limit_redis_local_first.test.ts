import type * as EnvModule from "../../../../../../src/shared/config/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consumeSocketRateLimitRedisMock = vi.fn();

vi.mock("../../../../../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis", () => ({
  consumeSocketRateLimitRedis: (...args: unknown[]) => consumeSocketRateLimitRedisMock(...args),
}));

vi.mock("../../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketRateLimitRedisUrl: "redis://127.0.0.1:6379",
      socketRateLimitRedisLocalFirst: false,
    },
  };
});

import { env } from "../../../../../../src/shared/config/env";
import { consumeSocketRateLimitLocalFirstAsync } from "../../../../../../src/presentation/socket/hub/rate_limits/socket_rate_limit_redis_local_first";

const baseInput = {
  scope: "relay_rpc_request" as const,
  key: "relay:user:test",
  windowMs: 10_000,
  max: 4,
  cost: 1,
};

describe("socket_rate_limit_redis_local_first", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.socketRateLimitRedisUrl = "redis://127.0.0.1:6379";
    env.socketRateLimitRedisLocalFirst = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should await Redis and record legacy metrics when local-first is disabled", async () => {
    consumeSocketRateLimitRedisMock.mockResolvedValue({
      allowed: true,
      remaining: 3,
      limit: 4,
      used: 1,
    });
    const onLegacyRedisDecision = vi.fn();
    const allowLocal = vi.fn(() => true);

    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal,
      refundLocal: vi.fn(),
      onLegacyRedisDecision,
    });

    expect(allowed).toBe(true);
    expect(consumeSocketRateLimitRedisMock).toHaveBeenCalledTimes(1);
    expect(onLegacyRedisDecision).toHaveBeenCalledWith(true);
    expect(allowLocal).not.toHaveBeenCalled();
  });

  it("should fall back to allowLocal when Redis is unavailable on the legacy path", async () => {
    consumeSocketRateLimitRedisMock.mockResolvedValue(null);
    const allowLocal = vi.fn(() => false);

    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal,
      refundLocal: vi.fn(),
      onLegacyRedisDecision: vi.fn(),
    });

    expect(allowed).toBe(false);
    expect(allowLocal).toHaveBeenCalledTimes(1);
  });

  it("should skip Redis on local deny when local-first is enabled", async () => {
    env.socketRateLimitRedisLocalFirst = true;
    const allowLocal = vi.fn(() => false);

    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal,
      refundLocal: vi.fn(),
      onLegacyRedisDecision: vi.fn(),
    });

    expect(allowed).toBe(false);
    expect(allowLocal).toHaveBeenCalledTimes(1);
    expect(consumeSocketRateLimitRedisMock).not.toHaveBeenCalled();
  });

  it("should return immediately on local allow and reconcile with Redis in the background", async () => {
    vi.useFakeTimers();
    env.socketRateLimitRedisLocalFirst = true;

    let resolveRedis!: (value: {
      allowed: boolean;
      remaining: number;
      limit: number;
      used: number;
    }) => void;
    consumeSocketRateLimitRedisMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRedis = resolve;
        }),
    );

    const refundLocal = vi.fn();
    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal: () => true,
      refundLocal,
      onLegacyRedisDecision: vi.fn(),
    });

    expect(allowed).toBe(true);
    expect(consumeSocketRateLimitRedisMock).toHaveBeenCalledTimes(1);

    resolveRedis({ allowed: false, remaining: 0, limit: 4, used: 4 });
    await vi.runAllTimersAsync();

    expect(refundLocal).toHaveBeenCalledTimes(1);
  });

  it("should keep local consume on async Redis failure (fail-open)", async () => {
    vi.useFakeTimers();
    env.socketRateLimitRedisLocalFirst = true;
    consumeSocketRateLimitRedisMock.mockResolvedValue(null);
    const refundLocal = vi.fn();

    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal: () => true,
      refundLocal,
      onLegacyRedisDecision: vi.fn(),
    });

    expect(allowed).toBe(true);
    await vi.runAllTimersAsync();
    expect(refundLocal).not.toHaveBeenCalled();
  });

  it("should not refund local when async Redis also allows", async () => {
    vi.useFakeTimers();
    env.socketRateLimitRedisLocalFirst = true;
    consumeSocketRateLimitRedisMock.mockResolvedValue({
      allowed: true,
      remaining: 2,
      limit: 4,
      used: 2,
    });
    const refundLocal = vi.fn();

    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal: () => true,
      refundLocal,
      onLegacyRedisDecision: vi.fn(),
    });

    expect(allowed).toBe(true);
    await vi.runAllTimersAsync();
    expect(refundLocal).not.toHaveBeenCalled();
  });

  it("should use legacy await-Redis path when Redis URL is empty even if local-first is enabled", async () => {
    env.socketRateLimitRedisLocalFirst = true;
    env.socketRateLimitRedisUrl = "";
    consumeSocketRateLimitRedisMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      limit: 4,
      used: 4,
    });
    const allowLocal = vi.fn(() => true);

    const allowed = await consumeSocketRateLimitLocalFirstAsync(baseInput, {
      allowLocal,
      refundLocal: vi.fn(),
      onLegacyRedisDecision: vi.fn((decision) => {
        expect(decision).toBe(false);
      }),
    });

    expect(allowed).toBe(false);
    expect(consumeSocketRateLimitRedisMock).toHaveBeenCalledTimes(1);
    expect(allowLocal).not.toHaveBeenCalled();
  });
});
