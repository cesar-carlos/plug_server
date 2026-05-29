import { performance } from "node:perf_hooks";

import { withRedisSpan } from "../../observability/redis_span";
import { validateRedisClusterTopology } from "../cluster/cluster_topology_validator";
import { LuaScriptCache, type CachedLuaScript } from "../scripting/lua_script_cache";
import { createManagedRedisConnection } from "../connection/managed_redis_connection";
import { createRedisCircuitBreaker } from "../connection/redis_circuit_breaker";
import { redisKeyNamespace, sanitizeRedisKeySegment } from "../keyspace/redis_key_namespace";
import {
  noteSocketRateLimitRedisAtomicRollback,
  noteSocketRateLimitRedisCircuitClosed,
  noteSocketRateLimitRedisCircuitOpened,
  noteSocketRateLimitRedisCommandError,
  noteSocketRateLimitRedisConnected,
  noteSocketRateLimitRedisDecision,
  noteSocketRateLimitRedisDisconnected,
  noteSocketRateLimitRedisFallback,
  noteSocketRateLimitRedisRecovered,
  noteSocketRateLimitRedisSaturation,
  noteSocketRateLimitRedisSkippedEmptyUrl,
  noteSocketRateLimitRedisTrackedKey,
  noteSocketRateLimitRedisWindowReset,
  observeSocketRateLimitRedisLatency,
} from "../../../application/services/socket_rate_limit_redis_metrics.service";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";

const connection = createManagedRedisConnection();
let scriptCache: LuaScriptCache | undefined;

const CONSUME_SCRIPT: CachedLuaScript = {
  name: "socket_rate_limit_consume",
  source: "", // assigned after script body declaration below to keep TS happy
};

const CONSUME_OR_ROLLBACK_SCRIPT: CachedLuaScript = {
  name: "socket_rate_limit_consume_or_rollback",
  source: "", // assigned after script body declaration below
};

const REFUND_SCRIPT: CachedLuaScript = {
  name: "socket_rate_limit_refund",
  source: "", // assigned after script body declaration below
};
const circuitBreaker = createRedisCircuitBreaker({
  getFailureThreshold: () => env.redisRateLimitCircuitFailureThreshold,
  getOpenMs: () => env.redisRateLimitCircuitOpenMs,
  callbacks: {
    onCommandError: () => noteSocketRateLimitRedisCommandError(),
    onOpened: (error: unknown) => {
      noteSocketRateLimitRedisCircuitOpened();
      logger.warn("socket_rate_limit_redis_circuit_opened", {
        message: toSafeErrorMessage(error),
      });
    },
    onClosed: () => {
      noteSocketRateLimitRedisCircuitClosed();
      logger.info("socket_rate_limit_redis_circuit_closed");
    },
    onRecovered: () => noteSocketRateLimitRedisRecovered(),
  },
});

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

const isRedisCircuitOpen = (): boolean => circuitBreaker.isOpen();

const recordRedisCommandFailure = (error: unknown): void => {
  circuitBreaker.recordFailure(error);
};

const recordRedisCommandSuccess = (): void => {
  circuitBreaker.recordSuccess();
};

const normalizeKey = (key: string): string => sanitizeRedisKeySegment(key);

/** Single round-trip: avoids a successful `DECRBY` followed by a failed `DEL` retrying and decrementing twice. */
const SOCKET_RATE_LIMIT_REFUND_SCRIPT = `
local v = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if v <= 0 then
  redis.call('DEL', KEYS[1])
end
return v
`;
(REFUND_SCRIPT as { source: string }).source = SOCKET_RATE_LIMIT_REFUND_SCRIPT;

/**
 * Single round-trip consume: increments the counter and conditionally sets
 * the window TTL when (a) this is the first hit creating the key (`v == cost`)
 * or (b) the existing key is missing a TTL. Returns the post-increment value.
 *
 * Saves one round-trip vs the previous `INCRBY` + (`PEXPIRE` or `PTTL`+`PEXPIRE`)
 * sequence. Trade-off: pushes ~1 microsecond of CPU work onto the (single-
 * threaded) Redis server in exchange for half the network latency. Net win
 * for hub workloads where round-trip dominates.
 *
 * Kept around for back-compat / tests; the hot path now uses
 * {@link SOCKET_RATE_LIMIT_CONSUME_OR_ROLLBACK_SCRIPT}, which folds the
 * over-limit rollback into the same call (1 RTT on deny vs the previous 2).
 */
const SOCKET_RATE_LIMIT_CONSUME_SCRIPT = `
local cost = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local v = redis.call('INCRBY', KEYS[1], cost)
if v == cost then
  redis.call('PEXPIRE', KEYS[1], windowMs)
else
  if redis.call('PTTL', KEYS[1]) < 0 then
    redis.call('PEXPIRE', KEYS[1], windowMs)
  end
end
return v
`;
(CONSUME_SCRIPT as { source: string }).source = SOCKET_RATE_LIMIT_CONSUME_SCRIPT;

/**
 * Atomic consume-or-rollback: same window/TTL semantics as
 * `SOCKET_RATE_LIMIT_CONSUME_SCRIPT` plus an in-script rollback when the
 * post-increment counter exceeds `max`. Returns `{allowed, used}` so the
 * caller can decide without a second round-trip.
 *
 *   ARGV[1] = cost
 *   ARGV[2] = windowMs
 *   ARGV[3] = max
 *
 * Reply (Lua array → Resp 2-element array):
 *   {1, used}  when the request is allowed (used <= max)
 *   {0, used}  when the request was rolled back (post-DECRBY value)
 *
 * Reduces deny-path RTTs from 2 (consume + refund) to 1 — the hottest
 * burst-absorbing case for the rate limiter.
 */
const SOCKET_RATE_LIMIT_CONSUME_OR_ROLLBACK_SCRIPT = `
local cost = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxAllowed = tonumber(ARGV[3])
local v = redis.call('INCRBY', KEYS[1], cost)
if v == cost then
  redis.call('PEXPIRE', KEYS[1], windowMs)
elseif redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
end
if v > maxAllowed then
  v = redis.call('DECRBY', KEYS[1], cost)
  if v <= 0 then
    redis.call('DEL', KEYS[1])
  end
  return {0, v}
end
return {1, v}
`;
(CONSUME_OR_ROLLBACK_SCRIPT as { source: string }).source =
  SOCKET_RATE_LIMIT_CONSUME_OR_ROLLBACK_SCRIPT;

export const consumeSocketRateLimitRedis = async (
  input: SocketRateLimitRedisConsumeInput,
): Promise<SocketRateLimitRedisConsumeResult | null> => {
  const client = connection.getClient();
  if (!client || input.max <= 0 || input.windowMs <= 0) {
    return null;
  }
  if (isRedisCircuitOpen()) {
    return null;
  }

  const cost = Math.max(1, Math.floor(input.cost ?? 1));
  const redisKey = `plug_socket_rl:${redisKeyNamespace()}:${input.scope}:${normalizeKey(input.key)}`;
  noteSocketRateLimitRedisTrackedKey(redisKey);

  const startedAtMs = performance.now();
  try {
    const cache = scriptCache;
    /**
     * Single round-trip: the Lua script returns `[allowed, used]` and folds
     * the over-limit rollback in. Caller is now decoder-only — no second
     * span / RTT on the deny path.
     */
    const reply: unknown = await withRedisSpan(
      { module: "socket_rate_limit_redis", op: "consume", keyPrefix: "plug_socket_rl" },
      async () => {
        if (cache) {
          return cache.invoke<readonly (number | string)[]>(CONSUME_OR_ROLLBACK_SCRIPT, {
            keys: [redisKey],
            arguments: [String(cost), String(input.windowMs), String(input.max)],
          });
        }
        return client.eval(SOCKET_RATE_LIMIT_CONSUME_OR_ROLLBACK_SCRIPT, {
          keys: [redisKey],
          arguments: [String(cost), String(input.windowMs), String(input.max)],
        });
      },
    );
    recordRedisCommandSuccess();
    /**
     * Defensive parse: production node-redis returns `[number, number]`
     * for `{1, used}` Lua replies, but we treat anything malformed as a
     * fail-open (return `null` so the caller's in-memory limiter takes
     * over) rather than crash the request.
     */
    if (!Array.isArray(reply) || reply.length < 2) {
      logger.warn("socket_rate_limit_redis_consume_unexpected_reply", {
        scope: input.scope,
      });
      return null;
    }
    const allowedRaw = Number(reply[0]);
    const used = Math.max(0, Number(reply[1]));
    const allowed = allowedRaw === 1;
    /**
     * Window reset: when the script just created the key and set `PEXPIRE`,
     * `used` equals `cost` (the increment that bootstrapped the window).
     * The deny path with cost==max would also satisfy this, but in that
     * case the rollback already DECRBY'd to <= 0 so `used` < cost; the
     * heuristic stays accurate for the boundary-burst signal.
     */
    if (allowed && used === cost) {
      noteSocketRateLimitRedisWindowReset();
    }
    if (allowed && used === input.max) {
      noteSocketRateLimitRedisSaturation();
    }
    if (!allowed) {
      noteSocketRateLimitRedisAtomicRollback();
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
  } finally {
    observeSocketRateLimitRedisLatency("consume", performance.now() - startedAtMs);
  }
};

export const refundSocketRateLimitRedis = async (input: {
  readonly scope: SocketRateLimitScope;
  readonly key: string;
  readonly cost?: number;
}): Promise<void> => {
  const client = connection.getClient();
  if (!client || isRedisCircuitOpen()) {
    return;
  }
  const cost = Math.max(1, Math.floor(input.cost ?? 1));
  const redisKey = `plug_socket_rl:${redisKeyNamespace()}:${input.scope}:${normalizeKey(input.key)}`;

  const attemptRefund = async (): Promise<boolean> => {
    const startedAtMs = performance.now();
    try {
      await withRedisSpan(
        { module: "socket_rate_limit_redis", op: "refund_external", keyPrefix: "plug_socket_rl" },
        async () => {
          const cache = scriptCache;
          if (cache) {
            await cache.invoke(REFUND_SCRIPT, {
              keys: [redisKey],
              arguments: [String(cost)],
            });
          } else {
            await client.eval(SOCKET_RATE_LIMIT_REFUND_SCRIPT, {
              keys: [redisKey],
              arguments: [String(cost)],
            });
          }
        },
      );
      recordRedisCommandSuccess();
      return true;
    } catch (error: unknown) {
      recordRedisCommandFailure(error);
      logger.warn("socket_rate_limit_redis_refund_error", {
        scope: input.scope,
        message: toSafeErrorMessage(error),
      });
      return false;
    } finally {
      observeSocketRateLimitRedisLatency("refund", performance.now() - startedAtMs);
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

  if (connection.isConnectedTo(url)) {
    return;
  }

  await closeSocketRateLimitRedis();

  const result = await connection.connect({
    url,
    logName: "socket_rate_limit_redis",
    buildCallbacks: (isCurrent) => ({
      onConnected: () => {
        noteSocketRateLimitRedisConnected();
        logger.info("socket_rate_limit_redis_connected");
      },
      onError: () => {
        if (!isCurrent()) {
          return;
        }
        noteSocketRateLimitRedisFallback();
      },
      onEnd: () => {
        if (!isCurrent()) {
          return;
        }
        noteSocketRateLimitRedisDisconnected();
      },
      onReadyAfterReconnect: () => {
        circuitBreaker.reset();
        noteSocketRateLimitRedisConnected();
        logger.info("socket_rate_limit_redis_ready");
      },
      onFallback: () => {
        noteSocketRateLimitRedisFallback();
      },
    }),
  });

  if (result === undefined) {
    return;
  }
  const cache = new LuaScriptCache(result.client);
  try {
    await Promise.all([
      cache.load(CONSUME_SCRIPT),
      cache.load(CONSUME_OR_ROLLBACK_SCRIPT),
      cache.load(REFUND_SCRIPT),
    ]);
    scriptCache = cache;
  } catch (error: unknown) {
    // Pre-load failure is non-fatal: invoke() falls back to EVAL on every call.
    logger.warn("socket_rate_limit_redis_script_preload_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    scriptCache = undefined;
  }
  await validateRedisClusterTopology({
    client: result.client,
    logName: "socket_rate_limit_redis",
    sampleKeys: [
      `plug_socket_rl:${redisKeyNamespace()}:agents_command:probe`,
      `plug_socket_rl:${redisKeyNamespace()}:relay_rpc_request:probe`,
    ],
  });
}

export async function closeSocketRateLimitRedis(): Promise<void> {
  scriptCache = undefined;
  const hadClient = connection.getClient() !== undefined;
  await connection.teardown();
  circuitBreaker.reset();
  if (hadClient) {
    noteSocketRateLimitRedisDisconnected();
  }
}
