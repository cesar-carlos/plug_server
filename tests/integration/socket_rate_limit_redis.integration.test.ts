import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as SocketRedisModule from "../../src/infrastructure/redis/socket_rate_limit_redis";

import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeSocketRateLimitRedisInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

describe("socket Redis rate-limit integration", () => {
  let redisModule: typeof SocketRedisModule;
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "probe not started",
  };

  beforeAll(async () => {
    const infrastructure = await probeSocketRateLimitRedisInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }

    process.env.SOCKET_RATE_LIMIT_REDIS_URL = infrastructure.redisUrl;
    redisModule = await import("../../src/infrastructure/redis/socket_rate_limit_redis");
    await redisModule.initSocketRateLimitRedis();
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    if (infrastructureProbe.ok) {
      await redisModule.closeSocketRateLimitRedis();
    }
  });

  it("shares fixed-window budget and refund semantics through Redis", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);

    const key = `integration:${Date.now()}:${Math.random().toString(16).slice(2)}`;

    const first = await redisModule.consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key,
      windowMs: 30_000,
      max: 2,
      cost: 2,
    });
    expect(first).toMatchObject({
      allowed: true,
      remaining: 0,
    });

    const rejected = await redisModule.consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key,
      windowMs: 30_000,
      max: 2,
    });
    expect(rejected).toMatchObject({
      allowed: false,
      remaining: 0,
    });

    await redisModule.refundSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key,
    });

    const afterRefund = await redisModule.consumeSocketRateLimitRedis({
      scope: "relay_rpc_request",
      key,
      windowMs: 30_000,
      max: 2,
    });
    expect(afterRefund).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });
});
