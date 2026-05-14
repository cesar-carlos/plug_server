import { createHash, randomUUID } from "node:crypto";

import { createClient } from "redis";

import {
  noteClientSocketEventIdempotencyRedisCommandError,
  noteClientSocketEventIdempotencyRedisConnected,
  noteClientSocketEventIdempotencyRedisDisconnected,
  noteClientSocketEventIdempotencyRedisFallback,
  noteClientSocketEventIdempotencyRedisLockAcquired,
  noteClientSocketEventIdempotencyRedisSkippedEmptyUrl,
  noteClientSocketEventIdempotencyRedisWrite,
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

type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | undefined;
let redisUrlInUse: string | undefined;
let redisClientGeneration = 0;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const keyDigest = (clientId: string, idempotencyKey: string): string =>
  createHash("sha256").update(`${clientId}\0${idempotencyKey}`).digest("hex");

const entryKey = (clientId: string, idempotencyKey: string): string =>
  `plug_socket_event_idem:${keyDigest(clientId, idempotencyKey)}`;

const lockKey = (clientId: string, idempotencyKey: string): string =>
  `plug_socket_event_idem_lock:${keyDigest(clientId, idempotencyKey)}`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

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
  constructor(private readonly client: RedisClient) {}

  async getEntry(
    clientId: string,
    idempotencyKey: string,
  ): Promise<ClientSocketEventPublishIdempotencyEntry | undefined> {
    const key = entryKey(clientId, idempotencyKey);
    try {
      const [raw, ttl] = await Promise.all([this.client.get(key), this.client.pTTL(key)]);
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
    }
  }

  async acquireLock(
    clientId: string,
    idempotencyKey: string,
    ttlMs: number,
  ): Promise<string | undefined> {
    const token = randomUUID();
    try {
      const result = await this.client.set(lockKey(clientId, idempotencyKey), token, {
        NX: true,
        PX: ttlMs,
      });
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
    }
  }

  async releaseLock(clientId: string, idempotencyKey: string, token: string): Promise<void> {
    try {
      await this.client.eval(RELEASE_LOCK_SCRIPT, {
        keys: [lockKey(clientId, idempotencyKey)],
        arguments: [token],
      });
    } catch (error: unknown) {
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.warn("client_socket_event_idempotency_redis_unlock_failed", {
        message: toSafeErrorMessage(error),
      });
    }
  }
}

const disableRedisClient = (): void => {
  redisClientGeneration += 1;
  const client = redisClient;
  redisClient = undefined;
  redisUrlInUse = undefined;
  registerClientSocketEventPublishDistributedIdempotencyStore(undefined);
  if (client !== undefined) {
    void client.quit().catch(() => undefined);
  }
};

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

  if (redisClient !== undefined && redisUrlInUse === url) {
    return;
  }

  await closeClientSocketEventPublishIdempotencyRedis();

  try {
    const client = createClient({ url });
    redisClient = client;
    redisUrlInUse = url;
    redisClientGeneration += 1;
    const generation = redisClientGeneration;
    const isCurrentClient = (): boolean =>
      redisClient === client && redisClientGeneration === generation;

    client.on("error", (err: Error) => {
      if (!isCurrentClient()) {
        return;
      }
      noteClientSocketEventIdempotencyRedisCommandError();
      logger.error("client_socket_event_idempotency_redis_client_error", {
        message: err.message,
      });
    });
    client.on("end", () => {
      if (!isCurrentClient()) {
        return;
      }
      noteClientSocketEventIdempotencyRedisDisconnected();
    });

    await client.connect();
    registerClientSocketEventPublishDistributedIdempotencyStore(
      new RedisClientSocketEventPublishDistributedIdempotencyStore(client),
    );
    noteClientSocketEventIdempotencyRedisConnected();
    logger.info("client_socket_event_idempotency_redis_connected");
  } catch (error: unknown) {
    noteClientSocketEventIdempotencyRedisFallback();
    logger.warn("client_socket_event_idempotency_redis_fallback_memory", {
      message: toSafeErrorMessage(error),
    });
    disableRedisClient();
  }
}

export async function closeClientSocketEventPublishIdempotencyRedis(): Promise<void> {
  redisClientGeneration += 1;
  registerClientSocketEventPublishDistributedIdempotencyStore(undefined);
  if (redisClient === undefined) {
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
  redisUrlInUse = undefined;
  noteClientSocketEventIdempotencyRedisDisconnected();
}
