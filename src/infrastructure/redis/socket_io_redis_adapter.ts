import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { Server } from "socket.io";

import {
  noteSocketIoRedisAdapterAttachedServer,
  noteSocketIoRedisAdapterConnected,
  noteSocketIoRedisAdapterDisconnected,
  noteSocketIoRedisAdapterFallback,
  noteSocketIoRedisAdapterRuntimeError,
  noteSocketIoRedisAdapterSkippedEmptyUrl,
} from "../../application/services/socket_io_redis_adapter_metrics.service";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

type RedisClient = ReturnType<typeof createClient>;

let pubClient: RedisClient | undefined;
let subClient: RedisClient | undefined;
let redisUrlInUse: string | undefined;
let generation = 0;

export const isSocketIoRedisAdapterActive = (): boolean =>
  pubClient !== undefined && subClient !== undefined;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const disableAdapterClients = (): void => {
  generation += 1;
  const pub = pubClient;
  const sub = subClient;
  pubClient = undefined;
  subClient = undefined;
  redisUrlInUse = undefined;
  if (pub !== undefined) {
    void pub.quit().catch(() => undefined);
  }
  if (sub !== undefined) {
    void sub.quit().catch(() => undefined);
  }
};

export async function initSocketIoRedisAdapter(io: Server): Promise<void> {
  const url = env.socketIoRedisAdapterUrl.trim();
  if (url === "") {
    await closeSocketIoRedisAdapter();
    noteSocketIoRedisAdapterSkippedEmptyUrl();
    logger.info("socket_io_redis_adapter_skipped", {
      reason: "SOCKET_IO_REDIS_ADAPTER_URL empty",
    });
    return;
  }

  if (pubClient !== undefined && subClient !== undefined && redisUrlInUse === url) {
    io.adapter(createAdapter(pubClient, subClient));
    noteSocketIoRedisAdapterAttachedServer();
    return;
  }

  await closeSocketIoRedisAdapter();

  try {
    const pub = createClient({ url });
    const sub = pub.duplicate();
    pubClient = pub;
    subClient = sub;
    redisUrlInUse = url;
    generation += 1;
    const currentGeneration = generation;
    const isCurrent = (): boolean =>
      pubClient === pub && subClient === sub && generation === currentGeneration;

    const onError = (role: "pub" | "sub", error: Error): void => {
      if (!isCurrent()) {
        return;
      }
      noteSocketIoRedisAdapterRuntimeError();
      logger.error("socket_io_redis_adapter_client_error", {
        role,
        message: error.message,
      });
    };
    pub.on("error", (error: Error) => onError("pub", error));
    sub.on("error", (error: Error) => onError("sub", error));
    pub.on("end", () => {
      if (isCurrent()) {
        noteSocketIoRedisAdapterDisconnected();
      }
    });
    sub.on("end", () => {
      if (isCurrent()) {
        noteSocketIoRedisAdapterDisconnected();
      }
    });

    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    noteSocketIoRedisAdapterAttachedServer();
    noteSocketIoRedisAdapterConnected();
    logger.info("socket_io_redis_adapter_connected");
  } catch (error: unknown) {
    noteSocketIoRedisAdapterFallback();
    logger.warn("socket_io_redis_adapter_fallback_memory", {
      message: toSafeErrorMessage(error),
    });
    disableAdapterClients();
  }
}

export async function closeSocketIoRedisAdapter(): Promise<void> {
  generation += 1;
  const pub = pubClient;
  const sub = subClient;
  pubClient = undefined;
  subClient = undefined;
  redisUrlInUse = undefined;

  await Promise.allSettled([
    pub?.quit().catch(() => undefined),
    sub?.quit().catch(() => undefined),
  ]);
  if (pub !== undefined || sub !== undefined) {
    noteSocketIoRedisAdapterDisconnected();
  }
}
