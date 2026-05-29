import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { withRedisSpan } from "../observability/redis_span";
import { validateRedisClusterTopology } from "./cluster_topology_validator";
import {
  createInstrumentedRedisClient,
  type InstrumentedRedisClient,
} from "./instrumented_redis_client";
import { LuaScriptCache, type CachedLuaScript } from "./lua_script_cache";
import { createManagedRedisConnection } from "./managed_redis_connection";
import { redisKeyNamespace } from "./redis_key_namespace";
import {
  noteClientSocketEventIdempotencyRedisCommandError,
  noteClientSocketEventIdempotencyRedisConnected,
  noteClientSocketEventIdempotencyRedisDisconnected,
  noteClientSocketEventIdempotencyRedisFallback,
  noteClientSocketEventIdempotencyRedisLockAcquired,
  noteClientSocketEventIdempotencyRedisLockExtended,
  noteClientSocketEventIdempotencyRedisSkippedEmptyUrl,
  noteClientSocketEventIdempotencyRedisWrite,
  observeClientSocketEventIdempotencyRedisLatency,
} from "../../application/services/client_socket_event_idempotency_redis_metrics.service";
import {
  registerClientSocketEventPublishDistributedIdempotencyStore,
  type ClientSocketEventPublishDistributedIdempotencyStore,
} from "../../application/services/client_socket_event_publish_distributed_idempotency";
import type {
  ClientSocketEventPublishIdempotencyEntry,
  ClientSocketEventPublishIdempotencyResponse,
} from "../../application/services/client_socket_event_idempotency_store";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

type RedisClient = InstrumentedRedisClient;

const connection = createManagedRedisConnection();
let redisReadClient: RedisClient | undefined;
/**
 * Tracked for parity with the primary URL even though we do not yet check it
 * to skip re-init (the read client follows the primary's lifecycle). Kept so
 * future logic can detect URL changes without a fresh diff.
 */
let _redisReadUrlInUse: string | undefined;
let scriptCache: LuaScriptCache | undefined;

const RELEASE_LOCK_CACHED: CachedLuaScript = { name: "idem_release_lock", source: "" };
const EXTEND_LOCK_CACHED: CachedLuaScript = { name: "idem_extend_lock", source: "" };
const GET_WITH_TTL_CACHED: CachedLuaScript = { name: "idem_get_with_ttl", source: "" };

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const keyDigest = (clientId: string, idempotencyKey: string): string =>
  createHash("sha256").update(`${clientId}\0${idempotencyKey}`).digest("hex");

const entryKey = (clientId: string, idempotencyKey: string): string =>
  `plug_socket_event_idem:${redisKeyNamespace()}:${keyDigest(clientId, idempotencyKey)}`;

const lockKey = (clientId: string, idempotencyKey: string): string =>
  `plug_socket_event_idem_lock:${redisKeyNamespace()}:${keyDigest(clientId, idempotencyKey)}`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
(RELEASE_LOCK_CACHED as { source: string }).source = RELEASE_LOCK_SCRIPT;

/**
 * Atomic compare-and-pexpire: only renews the TTL if the caller still owns
 * the lock. Returns `1` on success, `0` when the token does not match (lock
 * expired or stolen).
 */
const EXTEND_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
(EXTEND_LOCK_CACHED as { source: string }).source = EXTEND_LOCK_SCRIPT;

/**
 * Single round-trip read: returns `{value, pttl}` so `getEntry` no longer issues
 * a separate `GET` + `PTTL` (2 RTT → 1 RTT on the read path). A missing key
 * yields `{false → nil, -2}` which decodes to `[null, -2]` in node-redis.
 */
const GET_WITH_TTL_SCRIPT = `
return {redis.call('GET', KEYS[1]), redis.call('PTTL', KEYS[1])}
`;
(GET_WITH_TTL_CACHED as { source: string }).source = GET_WITH_TTL_SCRIPT;

interface StoredEntry {
  readonly fingerprint: string;
  readonly response: ClientSocketEventPublishIdempotencyResponse;
}

const parseStoredEntry = (
  raw: string | null,
): Omit<ClientSocketEventPublishIdempotencyEntry, "expiresAtMs"> | undefined => {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (
      typeof parsed.fingerprint !== "string" ||
      parsed.response?.success !== true ||
      typeof parsed.response.eventId !== "string" ||
      typeof parsed.response.eventName !== "string" ||
      typeof parsed.response.recipients !== "number"
    ) {
      return undefined;
    }
    return {
      fingerprint: parsed.fingerprint,
      response: {
        success: true,
        eventId: parsed.response.eventId,
        eventName: parsed.response.eventName,
        recipients: parsed.response.recipients,
      },
    };
  } catch {
    return undefined;
  }
};

class RedisClientSocketEventPublishDistributedIdempotencyStore implements ClientSocketEventPublishDistributedIdempotencyStore {
  /**
   * `client` is the primary (read+write). `readClient` is an optional
   * read-replica connection consulted only by `getEntry`. Stale reads
   * during replication lag are tolerated because the publish path re-reads
   * via `getEntry` AFTER acquiring the lock — at which point the primary
   * had time to replicate the entry from any concurrent writer.
   */
  constructor(
    private readonly client: RedisClient,
    private readonly readClient: RedisClient,
  ) {}

  /**
   * Single round-trip `GET`+`PTTL` via Lua. Uses the cached `EVALSHA` when the
   * read path is the primary connection (no separate replica); a dedicated
   * replica connection falls back to `EVAL` (the module script cache is bound
   * to the primary client). Returns `{ raw, ttl }` with `raw=null` on miss.
   */
  private async readWithTtl(key: string): Promise<{ raw: string | null; ttl: number }> {
    const cache = scriptCache;
    const reply: unknown =
      cache !== undefined && this.readClient === this.client
        ? await cache.invoke(GET_WITH_TTL_CACHED, { keys: [key], arguments: [] })
        : await this.readClient.eval(GET_WITH_TTL_SCRIPT, { keys: [key], arguments: [] });
    const tuple = Array.isArray(reply) ? (reply as readonly unknown[]) : [];
    const rawValue = tuple[0];
    const raw = typeof rawValue === "string" ? rawValue : null;
    const ttlValue = Number(tuple[1]);
    const ttl = Number.isFinite(ttlValue) ? ttlValue : -2;
    return { raw, ttl };
  }

  async getEntry(
    clientId: string,
    idempotencyKey: string,
  ): Promise<ClientSocketEventPublishIdempotencyEntry | undefined> {
    const key = entryKey(clientId, idempotencyKey);
    const startedAtMs = performance.now();
    try {
      const { raw, ttl } = await this.readWithTtl(key);
      const parsed = parseStoredEntry(raw);
      if (parsed === undefined) {
        if (raw !== null) {
          await this.client.del(key);
        }
        return undefined;
      }
      return {
        ...parsed,
        expiresAtMs: ttl > 0 ? Date.now() + ttl : Date.now() + env.restSocketEventIdempotencyTtlMs,
      };
    } catch (error: unknown) {
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.warn("client_socket_event_idempotency_redis_get_failed", {
        message: toSafeErrorMessage(error),
      });
      return undefined;
    } finally {
      observeClientSocketEventIdempotencyRedisLatency("get", performance.now() - startedAtMs);
    }
  }

  async setEntry(
    clientId: string,
    idempotencyKey: string,
    entry: {
      readonly fingerprint: string;
      readonly response: ClientSocketEventPublishIdempotencyResponse;
    },
  ): Promise<void> {
    if (env.restSocketEventIdempotencyTtlMs === 0) {
      return;
    }
    const startedAtMs = performance.now();
    try {
      await this.client.set(entryKey(clientId, idempotencyKey), JSON.stringify(entry), {
        PX: env.restSocketEventIdempotencyTtlMs,
      });
      noteClientSocketEventIdempotencyRedisWrite();
    } catch (error: unknown) {
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.warn("client_socket_event_idempotency_redis_set_failed", {
        message: toSafeErrorMessage(error),
      });
      throw error;
    } finally {
      observeClientSocketEventIdempotencyRedisLatency("set", performance.now() - startedAtMs);
    }
  }

  async acquireLock(
    clientId: string,
    idempotencyKey: string,
    ttlMs: number,
  ): Promise<string | undefined> {
    const token = randomUUID();
    const startedAtMs = performance.now();
    try {
      const result = await withRedisSpan(
        {
          module: "client_socket_event_idempotency_redis",
          op: "lock",
          keyPrefix: "plug_socket_event_idem_lock",
        },
        () =>
          this.client.set(lockKey(clientId, idempotencyKey), token, {
            NX: true,
            PX: ttlMs,
          }),
      );
      if (result === "OK") {
        noteClientSocketEventIdempotencyRedisLockAcquired();
        return token;
      }
      return undefined;
    } catch (error: unknown) {
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.warn("client_socket_event_idempotency_redis_lock_failed", {
        message: toSafeErrorMessage(error),
      });
      throw error;
    } finally {
      observeClientSocketEventIdempotencyRedisLatency("lock", performance.now() - startedAtMs);
    }
  }

  async extendLock(
    clientId: string,
    idempotencyKey: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (ttlMs <= 0) {
      return false;
    }
    const startedAtMs = performance.now();
    try {
      const result = await withRedisSpan(
        {
          module: "client_socket_event_idempotency_redis",
          op: "extend",
          keyPrefix: "plug_socket_event_idem_lock",
        },
        () =>
          scriptCache
            ? scriptCache.invoke(EXTEND_LOCK_CACHED, {
                keys: [lockKey(clientId, idempotencyKey)],
                arguments: [token, String(Math.floor(ttlMs))],
              })
            : this.client.eval(EXTEND_LOCK_SCRIPT, {
                keys: [lockKey(clientId, idempotencyKey)],
                arguments: [token, String(Math.floor(ttlMs))],
              }),
      );
      const extended = Number(result) === 1;
      if (extended) {
        noteClientSocketEventIdempotencyRedisLockExtended();
      }
      return extended;
    } catch (error: unknown) {
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.warn("client_socket_event_idempotency_redis_lock_extend_failed", {
        message: toSafeErrorMessage(error),
      });
      return false;
    } finally {
      observeClientSocketEventIdempotencyRedisLatency("extend", performance.now() - startedAtMs);
    }
  }

  async releaseLock(clientId: string, idempotencyKey: string, token: string): Promise<void> {
    const startedAtMs = performance.now();
    try {
      await withRedisSpan(
        {
          module: "client_socket_event_idempotency_redis",
          op: "unlock",
          keyPrefix: "plug_socket_event_idem_lock",
        },
        async () => {
          if (scriptCache) {
            await scriptCache.invoke(RELEASE_LOCK_CACHED, {
              keys: [lockKey(clientId, idempotencyKey)],
              arguments: [token],
            });
          } else {
            await this.client.eval(RELEASE_LOCK_SCRIPT, {
              keys: [lockKey(clientId, idempotencyKey)],
              arguments: [token],
            });
          }
        },
      );
    } catch (error: unknown) {
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.warn("client_socket_event_idempotency_redis_unlock_failed", {
        message: toSafeErrorMessage(error),
      });
    } finally {
      observeClientSocketEventIdempotencyRedisLatency("unlock", performance.now() - startedAtMs);
    }
  }
}

export async function initClientSocketEventPublishIdempotencyRedis(): Promise<void> {
  const url = env.restSocketEventIdempotencyRedisUrl.trim();
  if (url === "" || env.restSocketEventIdempotencyTtlMs === 0) {
    await closeClientSocketEventPublishIdempotencyRedis();
    noteClientSocketEventIdempotencyRedisSkippedEmptyUrl();
    logger.info("client_socket_event_idempotency_redis_skipped", {
      reason:
        url === ""
          ? "REST_SOCKET_EVENT_IDEMPOTENCY_REDIS_URL empty"
          : "REST_SOCKET_EVENT_IDEMPOTENCY_TTL_MS disabled",
    });
    return;
  }

  if (connection.isConnectedTo(url)) {
    return;
  }

  await closeClientSocketEventPublishIdempotencyRedis();

  const result = await connection.connect({
    url,
    logName: "client_socket_event_idempotency_redis",
    buildCallbacks: (isCurrent) => ({
      onConnected: () => {
        noteClientSocketEventIdempotencyRedisConnected();
        logger.info("client_socket_event_idempotency_redis_connected");
      },
      onError: () => {
        if (!isCurrent()) {
          return;
        }
        noteClientSocketEventIdempotencyRedisCommandError();
      },
      onEnd: () => {
        if (!isCurrent()) {
          return;
        }
        noteClientSocketEventIdempotencyRedisDisconnected();
      },
      onFallback: () => {
        noteClientSocketEventIdempotencyRedisFallback();
      },
    }),
  });

  if (result === undefined) {
    return;
  }
  const { client, isCurrent: isCurrentClient } = result;

  /**
   * Optional read-replica client. Independently fail-open: if the replica
   * URL is set but unreachable, fall back to the primary for reads. Operators
   * see the failure via the same `*_fallback_memory` log line and metric.
   */
  const readUrl = env.restSocketEventIdempotencyRedisReadUrl.trim();
  let effectiveReadClient: RedisClient = client;
  if (readUrl !== "") {
    _redisReadUrlInUse = readUrl;
    const readClient = await createInstrumentedRedisClient({
      url: readUrl,
      logName: "client_socket_event_idempotency_redis_read",
      callbacks: {
        onConnected: () => {
          logger.info("client_socket_event_idempotency_redis_read_connected");
        },
        onError: () => {
          if (!isCurrentClient()) {
            return;
          }
          noteClientSocketEventIdempotencyRedisCommandError();
        },
        onEnd: () => undefined,
        onFallback: () => {
          logger.warn("client_socket_event_idempotency_redis_read_fallback_to_primary");
        },
      },
    });
    if (readClient !== undefined) {
      redisReadClient = readClient;
      effectiveReadClient = readClient;
    } else {
      _redisReadUrlInUse = undefined;
    }
  }

  registerClientSocketEventPublishDistributedIdempotencyStore(
    new RedisClientSocketEventPublishDistributedIdempotencyStore(client, effectiveReadClient),
  );
  const cache = new LuaScriptCache(client);
  try {
    await Promise.all([
      cache.load(RELEASE_LOCK_CACHED),
      cache.load(EXTEND_LOCK_CACHED),
      cache.load(GET_WITH_TTL_CACHED),
    ]);
    scriptCache = cache;
  } catch (error: unknown) {
    logger.warn("client_socket_event_idempotency_redis_script_preload_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    scriptCache = undefined;
  }
  await validateRedisClusterTopology({
    client,
    logName: "client_socket_event_idempotency_redis",
    sampleKeys: [
      `plug_socket_event_idem:${redisKeyNamespace()}:probe-entry`,
      `plug_socket_event_idem_lock:${redisKeyNamespace()}:probe-lock`,
    ],
  });
}

export async function closeClientSocketEventPublishIdempotencyRedis(): Promise<void> {
  scriptCache = undefined;
  registerClientSocketEventPublishDistributedIdempotencyStore(undefined);
  const readClient = redisReadClient;
  redisReadClient = undefined;
  _redisReadUrlInUse = undefined;
  const hadClient = connection.getClient() !== undefined;
  // `teardown` bumps the generation (invalidating both primary and read-replica
  // callbacks) before we quit the read client below.
  await connection.teardown();
  if (readClient !== undefined) {
    void readClient.quit().catch(() => undefined);
  }
  if (hadClient) {
    noteClientSocketEventIdempotencyRedisDisconnected();
  }
}
