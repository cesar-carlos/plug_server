import { RedisStore, type SendCommandFn } from "rate-limit-redis";
import { createClient } from "redis";
import type { Store } from "express-rate-limit";

import {
  noteRestRateLimitRedisConnected,
  noteRestRateLimitRedisCircuitClosed,
  noteRestRateLimitRedisCircuitOpened,
  noteRestRateLimitRedisCommandError,
  noteRestRateLimitRedisDisconnected,
  noteRestRateLimitRedisFallback,
  noteRestRateLimitRedisRecovered,
  noteRestRateLimitRedisSkippedEmptyUrl,
} from "../../application/services/rest_rate_limit_redis_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

let redisClient: ReturnType<typeof createClient> | undefined;
let redisSendCommand: SendCommandFn | undefined;
let redisCommandFailures = 0;
let circuitOpenUntilMs = 0;
let redisUrlInUse: string | undefined;
let redisClientGeneration = 0;

const redisCircuitFailureThreshold = 3;
const redisCircuitOpenMs = 5_000;

export type RestHttpRateLimitStoreScope =
  | "global"
  | "credential_auth"
  | "token_refresh"
  | "agents_commands_ip"
  | "agents_commands_user"
  | "agents_self_profile"
  | "admin_user_status"
  | "client_me_agents_post"
  | "client_socket_event_publish"
  | "client_thumbnail"
  | "client_password_recovery_request";

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recordRedisStoreUnavailable = (message: string, error: unknown): void => {
  noteRestRateLimitRedisFallback();
  logger.warn(message, { message: toSafeErrorMessage(error) });
};

const disableRedisStoreClient = (): void => {
  redisClientGeneration += 1;
  const client = redisClient;
  redisClient = undefined;
  redisSendCommand = undefined;
  redisCommandFailures = 0;
  circuitOpenUntilMs = 0;
  redisUrlInUse = undefined;
  if (client !== undefined) {
    void client.quit().catch(() => undefined);
  }
};

const isRedisCircuitOpen = (): boolean => Date.now() < circuitOpenUntilMs;

const recordRedisCommandFailure = (error: unknown): void => {
  redisCommandFailures += 1;
  noteRestRateLimitRedisCommandError();
  if (redisCommandFailures >= redisCircuitFailureThreshold) {
    circuitOpenUntilMs = Date.now() + redisCircuitOpenMs;
    redisCommandFailures = 0;
    noteRestRateLimitRedisCircuitOpened();
    logger.warn("rest_rate_limit_redis_circuit_opened", {
      openMs: redisCircuitOpenMs,
      message: toSafeErrorMessage(error),
    });
  }
};

const recordRedisCommandSuccess = (): void => {
  redisCommandFailures = 0;
  if (circuitOpenUntilMs !== 0) {
    circuitOpenUntilMs = 0;
    noteRestRateLimitRedisCircuitClosed();
    logger.info("rest_rate_limit_redis_circuit_closed");
  }
  noteRestRateLimitRedisRecovered();
};

const markRedisStoreWarmupHandled = (store: RedisStore): void => {
  const warmup = store as RedisStore & {
    readonly incrementScriptSha?: Promise<unknown>;
    readonly getScriptSha?: Promise<unknown>;
  };
  void warmup.incrementScriptSha?.catch(() => undefined);
  void warmup.getScriptSha?.catch(() => undefined);
};

export function createRestHttpRateLimitStore(
  scope: RestHttpRateLimitStoreScope,
): Store | undefined {
  if (redisSendCommand === undefined) {
    return undefined;
  }

  try {
    const store = new RedisStore({
      prefix: `plug_rl:${scope}:`,
      sendCommand: redisSendCommand,
    });
    markRedisStoreWarmupHandled(store);
    return store;
  } catch (error: unknown) {
    recordRedisStoreUnavailable("rest_rate_limit_redis_store_create_failed", error);
    disableRedisStoreClient();
    return undefined;
  }
}

/**
 * Connects optional Redis for `express-rate-limit` shared state across hub replicas.
 * Fail-open: on boot error, logs and leaves the in-memory store (per-process).
 */
export async function initRestHttpRateLimitRedis(): Promise<void> {
  const url = env.restRateLimitRedisUrl.trim();
  if (url === "") {
    await closeRestHttpRateLimitRedis();
    noteRestRateLimitRedisSkippedEmptyUrl();
    logger.info("rest_rate_limit_redis_skipped", { reason: "REST_RATE_LIMIT_REDIS_URL empty" });
    return;
  }

  if (redisClient !== undefined && redisSendCommand !== undefined && redisUrlInUse === url) {
    return;
  }

  await closeRestHttpRateLimitRedis();

  try {
    const client = createClient({ url });
    redisClient = client;
    redisUrlInUse = url;
    redisClientGeneration += 1;
    const generation = redisClientGeneration;
    let initialConnectSucceeded = false;
    const isCurrentClient = (): boolean =>
      redisClient === client && redisClientGeneration === generation;

    client.on("error", (err: Error) => {
      if (!isCurrentClient()) {
        return;
      }
      logger.error("rest_rate_limit_redis_client_error", { message: err.message });
      if (initialConnectSucceeded) {
        noteRestRateLimitRedisFallback();
      }
    });
    client.on("ready", () => {
      if (!isCurrentClient()) {
        return;
      }
      if (initialConnectSucceeded) {
        redisCommandFailures = 0;
        circuitOpenUntilMs = 0;
        noteRestRateLimitRedisConnected();
        logger.info("rest_rate_limit_redis_ready");
      }
    });
    client.on("end", () => {
      if (!isCurrentClient()) {
        return;
      }
      noteRestRateLimitRedisDisconnected();
    });
    await client.connect();
    initialConnectSucceeded = true;
    redisSendCommand = async (...args: string[]) => {
      if (!isCurrentClient()) {
        throw new Error("Redis rate-limit store unavailable");
      }
      if (isRedisCircuitOpen()) {
        throw new Error("Redis rate-limit store circuit is open");
      }
      try {
        const result = await client.sendCommand(args);
        recordRedisCommandSuccess();
        return result as unknown as Awaited<ReturnType<SendCommandFn>>;
      } catch (error: unknown) {
        recordRedisCommandFailure(error);
        logger.warn("rest_rate_limit_redis_command_error", {
          message: toSafeErrorMessage(error),
        });
        throw new Error("Redis rate-limit store unavailable");
      }
    };
    noteRestRateLimitRedisConnected();
    logger.info("rest_rate_limit_redis_connected");
  } catch (error: unknown) {
    recordRedisStoreUnavailable("rest_rate_limit_redis_fallback_memory", error);
    disableRedisStoreClient();
  }
}

export async function closeRestHttpRateLimitRedis(): Promise<void> {
  redisClientGeneration += 1;
  if (redisClient === undefined) {
    redisSendCommand = undefined;
    redisCommandFailures = 0;
    circuitOpenUntilMs = 0;
    redisUrlInUse = undefined;
    return;
  }
  const client = redisClient;
  redisClient = undefined;
  try {
    await client.quit();
  } catch {
    /* ignore */
  }
  redisSendCommand = undefined;
  redisCommandFailures = 0;
  circuitOpenUntilMs = 0;
  redisUrlInUse = undefined;
  noteRestRateLimitRedisDisconnected();
}
