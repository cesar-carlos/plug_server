import { createClient } from "redis";

import {
  noteSocketRateLimitRedisCircuitClosed,
  noteSocketRateLimitRedisCircuitOpened,
  noteSocketRateLimitRedisCommandError,
  noteSocketRateLimitRedisConnected,
  noteSocketRateLimitRedisDecision,
  noteSocketRateLimitRedisDisconnected,
  noteSocketRateLimitRedisFallback,
  noteSocketRateLimitRedisRecovered,
  noteSocketRateLimitRedisSkippedEmptyUrl,
  noteSocketRateLimitRedisTrackedKey,
} from "../../application/services/socket_rate_limit_redis_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

let redisClient: ReturnType<typeof createClient> | undefined;
let redisCommandFailures = 0;
let circuitOpenUntilMs = 0;
let redisUrlInUse: string | undefined;
let redisClientGeneration = 0;

const redisCircuitFailureThreshold = 3;
const redisCircuitOpenMs = 5_000;

export type SocketRateLimitScope =
  | "agents_command"
  | "agents_stream_pull_credits"
  | "relay_conversation_start"
  | "relay_rpc_request"
  | "relay_stream_pull_credits"
  | "agent_register"
  | "client_socket_event_publish";

export interface SocketRateLimitRedisConsumeInput {
  readonly scope: SocketRateLimitScope;
  readonly key: string;
  readonly windowMs: number;
  readonly max: number;
  readonly cost?: number;
}

export interface SocketRateLimitRedisConsumeResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  readonly used: number;
}

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRedisCircuitOpen = (): boolean => Date.now() < circuitOpenUntilMs;

const disableRedisClient = (): void => {
  redisClientGeneration += 1;
  const client = redisClient;
  redisClient = undefined;
  redisCommandFailures = 0;
  circuitOpenUntilMs = 0;
  redisUrlInUse = undefined;
  if (client !== undefined) {
    void client.quit().catch(() => undefined);
  }
};

const recordRedisCommandFailure = (error: unknown): void => {
  redisCommandFailures += 1;
  noteSocketRateLimitRedisCommandError();
  if (redisCommandFailures >= redisCircuitFailureThreshold) {
    circuitOpenUntilMs = Date.now() + redisCircuitOpenMs;
    redisCommandFailures = 0;
    noteSocketRateLimitRedisCircuitOpened();
    logger.warn("socket_rate_limit_redis_circuit_opened", {
      openMs: redisCircuitOpenMs,
      message: toSafeErrorMessage(error),
    });
  }
};

const recordRedisCommandSuccess = (): void => {
  redisCommandFailures = 0;
  if (circuitOpenUntilMs !== 0) {
    circuitOpenUntilMs = 0;
    noteSocketRateLimitRedisCircuitClosed();
    logger.info("socket_rate_limit_redis_circuit_closed");
  }
  noteSocketRateLimitRedisRecovered();
};

const normalizeKey = (key: string): string => key.replace(/[^A-Za-z0-9:_-]/g, "_");

/** Single round-trip: avoids a successful `DECRBY` followed by a failed `DEL` retrying and decrementing twice. */
const SOCKET_RATE_LIMIT_REFUND_SCRIPT = `
local v = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if v <= 0 then
  redis.call('DEL', KEYS[1])
end
return v
`;

export const consumeSocketRateLimitRedis = async (
  input: SocketRateLimitRedisConsumeInput,
): Promise<SocketRateLimitRedisConsumeResult | null> => {
  const client = redisClient;
  if (!client || input.max <= 0 || input.windowMs <= 0) {
    return null;
  }
  if (isRedisCircuitOpen()) {
    return null;
  }

  const cost = Math.max(1, Math.floor(input.cost ?? 1));
  const redisKey = `plug_socket_rl:${input.scope}:${normalizeKey(input.key)}`;
  noteSocketRateLimitRedisTrackedKey(redisKey);

  try {
    const usedRaw = await client.incrBy(redisKey, cost);
    if (usedRaw === cost) {
      await client.pExpire(redisKey, input.windowMs);
    } else {
      const ttl = await client.pTTL(redisKey);
      if (ttl < 0) {
        await client.pExpire(redisKey, input.windowMs);
      }
    }
    recordRedisCommandSuccess();
    let used = Number(usedRaw);
    let allowed = used <= input.max;
    if (!allowed) {
      try {
        const rolledBackRaw = await client.eval(SOCKET_RATE_LIMIT_REFUND_SCRIPT, {
          keys: [redisKey],
          arguments: [String(cost)],
        });
        used = Math.max(0, Number(rolledBackRaw));
        recordRedisCommandSuccess();
      } catch (error: unknown) {
        recordRedisCommandFailure(error);
        logger.warn("socket_rate_limit_redis_consume_rollback_error", {
          scope: input.scope,
          message: toSafeErrorMessage(error),
        });
        return null;
      }
    }
    noteSocketRateLimitRedisDecision(allowed);
    return {
      allowed,
      remaining: Math.max(0, input.max - used),
      limit: input.max,
      used,
    };
  } catch (error: unknown) {
    recordRedisCommandFailure(error);
    logger.warn("socket_rate_limit_redis_command_error", {
      scope: input.scope,
      message: toSafeErrorMessage(error),
    });
    return null;
  }
};

export const refundSocketRateLimitRedis = async (input: {
  readonly scope: SocketRateLimitScope;
  readonly key: string;
  readonly cost?: number;
}): Promise<void> => {
  const client = redisClient;
  if (!client || isRedisCircuitOpen()) {
    return;
  }
  const cost = Math.max(1, Math.floor(input.cost ?? 1));
  const redisKey = `plug_socket_rl:${input.scope}:${normalizeKey(input.key)}`;

  const attemptRefund = async (): Promise<boolean> => {
    try {
      await client.eval(SOCKET_RATE_LIMIT_REFUND_SCRIPT, {
        keys: [redisKey],
        arguments: [String(cost)],
      });
      recordRedisCommandSuccess();
      return true;
    } catch (error: unknown) {
      recordRedisCommandFailure(error);
      logger.warn("socket_rate_limit_redis_refund_error", {
        scope: input.scope,
        message: toSafeErrorMessage(error),
      });
      return false;
    }
  };

  if (!(await attemptRefund())) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
    await attemptRefund();
  }
};

export async function initSocketRateLimitRedis(): Promise<void> {
  const url = env.socketRateLimitRedisUrl.trim();
  if (url === "") {
    await closeSocketRateLimitRedis();
    noteSocketRateLimitRedisSkippedEmptyUrl();
    logger.info("socket_rate_limit_redis_skipped", {
      reason: "SOCKET_RATE_LIMIT_REDIS_URL empty",
    });
    return;
  }

  if (redisClient !== undefined && redisUrlInUse === url) {
    return;
  }

  await closeSocketRateLimitRedis();

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
      logger.error("socket_rate_limit_redis_client_error", { message: err.message });
      if (initialConnectSucceeded) {
        noteSocketRateLimitRedisFallback();
      }
    });
    client.on("ready", () => {
      if (!isCurrentClient()) {
        return;
      }
      if (initialConnectSucceeded) {
        redisCommandFailures = 0;
        circuitOpenUntilMs = 0;
        noteSocketRateLimitRedisConnected();
        logger.info("socket_rate_limit_redis_ready");
      }
    });
    client.on("end", () => {
      if (!isCurrentClient()) {
        return;
      }
      noteSocketRateLimitRedisDisconnected();
    });
    await client.connect();
    initialConnectSucceeded = true;
    noteSocketRateLimitRedisConnected();
    logger.info("socket_rate_limit_redis_connected");
  } catch (error: unknown) {
    noteSocketRateLimitRedisFallback();
    logger.warn("socket_rate_limit_redis_fallback_memory", {
      message: toSafeErrorMessage(error),
    });
    disableRedisClient();
  }
}

export async function closeSocketRateLimitRedis(): Promise<void> {
  redisClientGeneration += 1;
  if (redisClient === undefined) {
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
  redisCommandFailures = 0;
  circuitOpenUntilMs = 0;
  redisUrlInUse = undefined;
  noteSocketRateLimitRedisDisconnected();
}
