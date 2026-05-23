import { createAdapter } from "@socket.io/redis-adapter";
import { Adapter } from "socket.io-adapter";
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

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let pubClient: RedisClient | undefined;
let subClient: RedisClient | undefined;
let redisUrlInUse: string | undefined;
let generation = 0;
let attachedForCurrentGeneration = false;
let registeredIo: Server | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;

export const isSocketIoRedisAdapterActive = (): boolean =>
  pubClient !== undefined && subClient !== undefined;

const toSafeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attachInMemoryAdapter = (io: Server): void => {
  io.adapter(Adapter);
};

const clearReconnectTimer = (): void => {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
};

const resetReconnectBackoff = (): void => {
  reconnectAttempt = 0;
  clearReconnectTimer();
};

const shouldFailHardOnInitialConnect = (): boolean => {
  if (env.socketIoRedisAdapterUrl.trim() === "") {
    return false;
  }
  return env.nodeEnv === "production" || env.socketIoRedisAdapterRequired;
};

const scheduleReconnect = (): void => {
  const io = registeredIo;
  const url = env.socketIoRedisAdapterUrl.trim();
  if (io === undefined || url === "") {
    return;
  }

  clearReconnectTimer();
  const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void initSocketIoRedisAdapter(io).catch((error: unknown) => {
      logger.warn("socket_io_redis_adapter_reconnect_failed", {
        message: toSafeErrorMessage(error),
        attempt: reconnectAttempt,
      });
      scheduleReconnect();
    });
  }, delayMs);
};

const disableAdapterClients = (): void => {
  generation += 1;
  attachedForCurrentGeneration = false;
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

const fallBackToMemoryAndScheduleReconnect = (io: Server, isCurrent: () => boolean): void => {
  if (!isCurrent()) {
    return;
  }
  noteSocketIoRedisAdapterDisconnected();
  attachInMemoryAdapter(io);
  disableAdapterClients();
  if (env.socketIoRedisAdapterUrl.trim() !== "") {
    scheduleReconnect();
  }
};

export async function initSocketIoRedisAdapter(io: Server): Promise<void> {
  registeredIo = io;
  const url = env.socketIoRedisAdapterUrl.trim();
  if (url === "") {
    resetReconnectBackoff();
    await closeSocketIoRedisAdapter();
    noteSocketIoRedisAdapterSkippedEmptyUrl();
    logger.info("socket_io_redis_adapter_skipped", {
      reason: "SOCKET_IO_REDIS_ADAPTER_URL empty",
    });
    return;
  }

  if (pubClient !== undefined && subClient !== undefined && redisUrlInUse === url) {
    io.adapter(createAdapter(pubClient, subClient));
    if (!attachedForCurrentGeneration) {
      noteSocketIoRedisAdapterAttachedServer();
      attachedForCurrentGeneration = true;
    }
    return;
  }

  await closeSocketIoRedisAdapter({ preserveRegistration: true });

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
      fallBackToMemoryAndScheduleReconnect(io, isCurrent);
    };
    pub.on("error", (error: Error) => onError("pub", error));
    sub.on("error", (error: Error) => onError("sub", error));
    pub.on("end", () => {
      if (isCurrent()) {
        fallBackToMemoryAndScheduleReconnect(io, isCurrent);
      }
    });
    sub.on("end", () => {
      if (isCurrent()) {
        fallBackToMemoryAndScheduleReconnect(io, isCurrent);
      }
    });

    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    if (!attachedForCurrentGeneration) {
      noteSocketIoRedisAdapterAttachedServer();
      attachedForCurrentGeneration = true;
    }
    resetReconnectBackoff();
    noteSocketIoRedisAdapterConnected();
    logger.info("socket_io_redis_adapter_connected");
  } catch (error: unknown) {
    if (shouldFailHardOnInitialConnect()) {
      disableAdapterClients();
      throw error;
    }
    noteSocketIoRedisAdapterFallback();
    logger.warn("socket_io_redis_adapter_fallback_memory", {
      message: toSafeErrorMessage(error),
    });
    attachInMemoryAdapter(io);
    disableAdapterClients();
    scheduleReconnect();
  }
}

export async function reattachSocketIoRedisAdapter(): Promise<void> {
  if (registeredIo === undefined) {
    return;
  }
  await initSocketIoRedisAdapter(registeredIo);
}

export async function closeSocketIoRedisAdapter(options?: {
  readonly preserveRegistration?: boolean;
}): Promise<void> {
  if (!options?.preserveRegistration) {
    resetReconnectBackoff();
    registeredIo = undefined;
  }
  generation += 1;
  attachedForCurrentGeneration = false;
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
