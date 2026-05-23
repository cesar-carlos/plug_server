import type { Options } from "express-rate-limit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as RestRateLimitRedisModule from "../../src/infrastructure/redis/rest_rate_limit_redis";

import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeRestRateLimitRedisInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

const rateLimitStoreInitOptions = {
  windowMs: 30_000,
  limit: 2,
  message: "Too many requests",
  statusCode: 429,
} satisfies Pick<Options, "windowMs" | "limit" | "message" | "statusCode">;

describe("REST Redis rate-limit integration", () => {
  let redisModule: typeof RestRateLimitRedisModule;
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "probe not started",
  };

  beforeAll(async () => {
    const infrastructure = await probeRestRateLimitRedisInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }

    process.env.REST_RATE_LIMIT_REDIS_URL = infrastructure.redisUrl;
    vi.resetModules();
    redisModule = await import("../../src/infrastructure/redis/rest_rate_limit_redis");
    await redisModule.initRestHttpRateLimitRedis();
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    if (infrastructureProbe.ok) {
      await redisModule.closeRestHttpRateLimitRedis();
    }
  });

  it("shares fixed-window hit counts and decrement semantics through Redis", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);

    const key = `integration:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const storeA = redisModule.createRestHttpRateLimitStore("global");
    const storeB = redisModule.createRestHttpRateLimitStore("global");
    expect(storeA).toBeDefined();
    expect(storeB).toBeDefined();
    if (storeA === undefined || storeB === undefined) {
      return;
    }

    storeA.init(rateLimitStoreInitOptions as Options);
    storeB.init(rateLimitStoreInitOptions as Options);

    const first = await storeA.increment(key);
    expect(first.totalHits).toBe(1);

    const second = await storeB.increment(key);
    expect(second.totalHits).toBe(2);

    const rejected = await storeA.increment(key);
    expect(rejected.totalHits).toBe(3);

    await storeA.decrement(key);

    const afterDecrement = await storeB.increment(key);
    expect(afterDecrement.totalHits).toBe(3);

    await storeA.resetKey(key);
  });
});
