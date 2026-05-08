import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as SocketRedisModule from "../../src/infrastructure/redis/socket_rate_limit_redis";

const redisUrl = process.env.SOCKET_RATE_LIMIT_REDIS_URL;
const describeIfRedis = redisUrl && redisUrl.trim() !== "" ? describe : describe.skip;

describeIfRedis("socket Redis rate-limit integration", () => {
  let redisModule: typeof SocketRedisModule;

  beforeAll(async () => {
    redisModule = await import("../../src/infrastructure/redis/socket_rate_limit_redis");
    await redisModule.initSocketRateLimitRedis();
  });

  afterAll(async () => {
    await redisModule.closeSocketRateLimitRedis();
  });

  it("shares fixed-window budget and refund semantics through Redis", async () => {
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
