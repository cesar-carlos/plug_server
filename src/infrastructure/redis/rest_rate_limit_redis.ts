import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import type { Store } from "express-rate-limit";

import {
  noteRestRateLimitRedisConnected,
  noteRestRateLimitRedisDisconnected,
  noteRestRateLimitRedisFallback,
  noteRestRateLimitRedisSkippedEmptyUrl,
} from "../../application/services/rest_rate_limit_redis_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

let redisClient: ReturnType<typeof createClient> | undefined;
let sharedStore: Store | undefined;

export function getRestHttpRateLimitStore(): Store | undefined {
  return sharedStore;
}

/**
 * Connects optional Redis for `express-rate-limit` shared state across hub replicas.
 * Fail-open: on error, logs and leaves the in-memory store (per-process).
 */
export async function initRestHttpRateLimitRedis(): Promise<void> {
  const url = env.restRateLimitRedisUrl.trim();
  if (url === "") {
    noteRestRateLimitRedisSkippedEmptyUrl();
    logger.info("rest_rate_limit_redis_skipped", { reason: "REST_RATE_LIMIT_REDIS_URL empty" });
    return;
  }

  try {
    const client = createClient({ url });
    redisClient = client;
    client.on("error", (err: Error) => {
      logger.error("rest_rate_limit_redis_client_error", { message: err.message });
    });
    await client.connect();
    sharedStore = new RedisStore({
      prefix: "plug_rl:",
      sendCommand: (...args: string[]) => client.sendCommand(args),
    });
    noteRestRateLimitRedisConnected();
    logger.info("rest_rate_limit_redis_connected");
  } catch (error: unknown) {
    noteRestRateLimitRedisFallback();
    logger.warn("rest_rate_limit_redis_fallback_memory", {
      message: error instanceof Error ? error.message : String(error),
    });
    sharedStore = undefined;
    if (redisClient !== undefined) {
      try {
        await redisClient.quit();
      } catch {
        /* ignore */
      }
      redisClient = undefined;
    }
  }
}

export async function closeRestHttpRateLimitRedis(): Promise<void> {
  if (redisClient === undefined) {
    sharedStore = undefined;
    return;
  }
  try {
    await redisClient.quit();
  } catch {
    /* ignore */
  }
  redisClient = undefined;
  sharedStore = undefined;
  noteRestRateLimitRedisDisconnected();
}
