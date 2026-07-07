import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetAgentRegisterRateLimitState,
  sweepAgentRegisterRateLimitState,
  tryConsumeAgentRegisterRateLimit,
  tryConsumeAgentRegisterRateLimitAsync,
} from "../../../../../src/presentation/socket/hub/rate_limits/agent_register_rate_limit";
import { env } from "../../../../../src/shared/config/env";

vi.mock("../../../../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis", () => ({
  consumeSocketRateLimitRedis: vi.fn(),
}));

import { consumeSocketRateLimitRedis } from "../../../../../src/infrastructure/redis/rate_limit/socket_rate_limit_redis";

const mockedConsumeSocketRateLimitRedis = vi.mocked(consumeSocketRateLimitRedis);

describe("agent_register_rate_limit", () => {
  afterEach(() => {
    resetAgentRegisterRateLimitState();
    mockedConsumeSocketRateLimitRedis.mockReset();
  });

  it("allows bursts within max inside the window", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(tryConsumeAgentRegisterRateLimit("u1", "a1", { windowMs: 60_000, max: 3 })).toEqual({
        ok: true,
      });
    }
    expect(tryConsumeAgentRegisterRateLimit("u1", "a1", { windowMs: 60_000, max: 3 })).toEqual({
      ok: false,
    });
  });

  it("prunes stale timestamps on reject so expired slots free capacity", () => {
    const windowMs = 1000;
    const max = 2;
    expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: true });
    expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: true });
    expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: false });

    const later = Date.now() + windowMs + 50;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(tryConsumeAgentRegisterRateLimit("u", "a", { windowMs, max })).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("drops bucket entry when all stamps expired before next consume", () => {
    const windowMs = 50;
    expect(tryConsumeAgentRegisterRateLimit("ux", "ax", { windowMs, max: 5 })).toEqual({
      ok: true,
    });

    const later = Date.now() + windowMs + 10;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(tryConsumeAgentRegisterRateLimit("ux", "ax", { windowMs, max: 5 })).toEqual({
        ok: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("uses Redis decision when available", async () => {
    mockedConsumeSocketRateLimitRedis.mockResolvedValue({
      allowed: false,
      remaining: 0,
      limit: 3,
      used: 4,
    });

    await expect(
      tryConsumeAgentRegisterRateLimitAsync("u1", "a1", { windowMs: 60_000, max: 3 }),
    ).resolves.toEqual({ ok: false });
    expect(mockedConsumeSocketRateLimitRedis).toHaveBeenCalledWith({
      scope: "agent_register",
      key: "u1:a1",
      windowMs: 60_000,
      max: 3,
    });
  });

  it("falls back to in-memory limiter when Redis returns null", async () => {
    mockedConsumeSocketRateLimitRedis.mockResolvedValue(null);

    for (let i = 0; i < 2; i += 1) {
      await expect(
        tryConsumeAgentRegisterRateLimitAsync("u2", "a2", { windowMs: 60_000, max: 2 }),
      ).resolves.toEqual({ ok: true });
    }

    await expect(
      tryConsumeAgentRegisterRateLimitAsync("u2", "a2", { windowMs: 60_000, max: 2 }),
    ).resolves.toEqual({ ok: false });
  });

  it("sweep removes stale register buckets", () => {
    expect(tryConsumeAgentRegisterRateLimit("u-sweep", "a-sweep", { windowMs: 60_000, max: 3 })).toEqual(
      { ok: true },
    );

    const later =
      Date.now() +
      env.socketAgentRegisterRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier +
      1;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      sweepAgentRegisterRateLimitState();
      expect(
        tryConsumeAgentRegisterRateLimit("u-sweep", "a-sweep", { windowMs: 60_000, max: 3 }),
      ).toEqual({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });
});
