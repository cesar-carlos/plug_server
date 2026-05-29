import { performance } from "node:perf_hooks";

import { RedisStore, type SendCommandFn } from "rate-limit-redis";
import type { Store } from "express-rate-limit";

import { validateRedisClusterTopology } from "../cluster/cluster_topology_validator";
import { createManagedRedisConnection } from "../connection/managed_redis_connection";
import { createRedisCircuitBreaker } from "../connection/redis_circuit_breaker";
import { redisKeyNamespace } from "../keyspace/redis_key_namespace";
import {
  noteRestRateLimitRedisConnected,
  noteRestRateLimitRedisCircuitClosed,
  noteRestRateLimitRedisCircuitOpened,
  noteRestRateLimitRedisCommandError,
  noteRestRateLimitRedisDisconnected,
  noteRestRateLimitRedisFallback,
  noteRestRateLimitRedisRecovered,
  noteRestRateLimitRedisSkippedEmptyUrl,
  observeRestRateLimitRedisLatency,
} from "../../../application/services/rest_rate_limit_redis_metrics.service";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";

const connection = createManagedRedisConnection();
let redisSendCommand: SendCommandFn | undefined;

const circuitBreaker = createRedisCircuitBreaker({
  getFailureThreshold: () => env.redisRateLimitCircuitFailureThreshold,
  getOpenMs: () => env.redisRateLimitCircuitOpenMs,
  callbacks: {
    onCommandError: () => noteRestRateLimitRedisCommandError(),
    onOpened: (error: unknown) => {
      noteRestRateLimitRedisCircuitOpened();
      logger.warn("rest_rate_limit_redis_circuit_opened", {
        message: toSafeErrorMessage(error),
      });
    },
    onClosed: () => {
      noteRestRateLimitRedisCircuitClosed();
      logger.info("rest_rate_limit_redis_circuit_closed");
    },
    onRecovered: () => noteRestRateLimitRedisRecovered(),
  },
});

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
  const client = connection.detach();
  redisSendCommand = undefined;
  circuitBreaker.reset();
  if (client !== undefined) {
    void client.quit().catch(() => undefined);
  }
};

const isRedisCircuitOpen = (): boolean => circuitBreaker.isOpen();

const recordRedisCommandFailure = (error: unknown): void => {
  circuitBreaker.recordFailure(error);
};

const recordRedisCommandSuccess = (): void => {
  circuitBreaker.recordSuccess();
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
      prefix: `plug_rl:${redisKeyNamespace()}:${scope}:`,
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

  if (connection.isConnectedTo(url) && redisSendCommand !== undefined) {
    return;
  }

  await closeRestHttpRateLimitRedis();

  const result = await connection.connect({
    url,
    logName: "rest_rate_limit_redis",
    buildCallbacks: (isCurrent) => ({
      onConnected: () => {
        noteRestRateLimitRedisConnected();
        logger.info("rest_rate_limit_redis_connected");
      },
      onError: () => {
        if (!isCurrent()) {
          return;
        }
        noteRestRateLimitRedisFallback();
      },
      onEnd: () => {
        if (!isCurrent()) {
          return;
        }
        noteRestRateLimitRedisDisconnected();
      },
      onReadyAfterReconnect: () => {
        circuitBreaker.reset();
        noteRestRateLimitRedisConnected();
        logger.info("rest_rate_limit_redis_ready");
      },
      onFallback: (error: unknown) => {
        recordRedisStoreUnavailable("rest_rate_limit_redis_fallback_memory", error);
      },
    }),
  });

  if (result === undefined) {
    return;
  }
  const { client, isCurrent } = result;

  redisSendCommand = async (...args: string[]) => {
    if (!isCurrent() || connection.getClient() !== client) {
      throw new Error("Redis rate-limit store unavailable");
    }
    if (isRedisCircuitOpen()) {
      throw new Error("Redis rate-limit store circuit is open");
    }
    const startedAtMs = performance.now();
    try {
      const commandResult = await client.sendCommand(args);
      recordRedisCommandSuccess();
      return commandResult as unknown as Awaited<ReturnType<SendCommandFn>>;
    } catch (error: unknown) {
      recordRedisCommandFailure(error);
      logger.warn("rest_rate_limit_redis_command_error", {
        message: toSafeErrorMessage(error),
      });
      throw new Error("Redis rate-limit store unavailable");
    } finally {
      observeRestRateLimitRedisLatency(performance.now() - startedAtMs);
    }
  };
  await validateRedisClusterTopology({
    client,
    logName: "rest_rate_limit_redis",
    sampleKeys: [
      `plug_rl:${redisKeyNamespace()}:global:probe`,
      `plug_rl:${redisKeyNamespace()}:credential_auth:probe`,
    ],
  });
}

export async function closeRestHttpRateLimitRedis(): Promise<void> {
  const hadClient = connection.getClient() !== undefined;
  await connection.teardown();
  redisSendCommand = undefined;
  circuitBreaker.reset();
  if (hadClient) {
    noteRestRateLimitRedisDisconnected();
  }
}
