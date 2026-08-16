import { performance } from "node:perf_hooks";

import { createAdapter } from "@socket.io/redis-adapter";
import { Adapter } from "socket.io-adapter";
import type { Server } from "socket.io";

import {
  noteSocketIoRedisAdapterAttachedServer,
  noteSocketIoRedisAdapterConnected,
  noteSocketIoRedisAdapterDisconnected,
  noteSocketIoRedisAdapterFallback,
  noteSocketIoRedisAdapterRuntimeError,
  noteSocketIoRedisAdapterSkippedEmptyUrl,
  observeSocketIoRedisAdapterConnectLatency,
} from "../../../application/services/socket_io_redis_adapter_metrics.service";
import { env } from "../../../shared/config/env";
import { logger } from "../../../shared/utils/logger";
import type { InstrumentedRedisClient } from "../connection/instrumented_redis_client";
import { createPubSubInstrumentedRedisClients } from "../connection/pubsub_instrumented_redis_client";
import { buildResilientRedisClientOptions } from "../connection/redis_client_options";

type RedisClient = InstrumentedRedisClient;

export const buildSocketIoRedisAdapterClientOptions = (): ReturnType<
  typeof buildResilientRedisClientOptions
> =>
  buildResilientRedisClientOptions({
    url: env.socketIoRedisAdapterUrl.trim(),
    logName: "socket_io_redis_adapter",
    connectTimeoutMs: env.socketIoRedisAdapterConnectTimeoutMs,
    reconnectBaseMs: env.socketIoRedisAdapterReconnectBaseMs,
    reconnectMaxMs: env.socketIoRedisAdapterReconnectMaxMs,
  });

export const buildSocketIoRedisAdapterOptions = (): {
  readonly key: string;
  readonly requestsTimeout: number;
  readonly publishOnSpecificResponseChannel: boolean;
} => ({
  key: env.socketIoRedisAdapterKey,
  requestsTimeout: env.socketIoRedisAdapterRequestsTimeoutMs,
  publishOnSpecificResponseChannel: env.socketIoRedisAdapterPublishOnSpecificResponseChannel,
});

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
  const delayMs = Math.min(
    env.socketIoRedisAdapterReconnectBaseMs * 2 ** reconnectAttempt,
    env.socketIoRedisAdapterReconnectMaxMs,
  );
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
    io.adapter(createAdapter(pubClient, subClient, buildSocketIoRedisAdapterOptions()));
    if (!attachedForCurrentGeneration) {
      noteSocketIoRedisAdapterAttachedServer();
      attachedForCurrentGeneration = true;
    }
    return;
  }

  await closeSocketIoRedisAdapter({ preserveRegistration: true });

  generation += 1;
  const currentGeneration = generation;
  redisUrlInUse = url;
  const isCurrent = (): boolean => generation === currentGeneration;

  let factoryError: unknown;
  const connectStartedAtMs = performance.now();
  const clients = await createPubSubInstrumentedRedisClients({
    url,
    logName: "socket_io_redis_adapter",
    buildClientOptions: buildSocketIoRedisAdapterClientOptions,
    isCurrent,
    callbacks: {
      onConnected: () => undefined,
      onError: () => {
        if (!isCurrent()) {
          return;
        }
        noteSocketIoRedisAdapterRuntimeError();
        fallBackToMemoryAndScheduleReconnect(io, isCurrent);
      },
      onEnd: () => {
        if (!isCurrent()) {
          return;
        }
        fallBackToMemoryAndScheduleReconnect(io, isCurrent);
      },
      onFallback: (error: unknown) => {
        factoryError = error;
      },
    },
  });
  observeSocketIoRedisAdapterConnectLatency(performance.now() - connectStartedAtMs);

  if (clients === undefined) {
    if (shouldFailHardOnInitialConnect()) {
      throw factoryError ?? new Error("socket_io_redis_adapter_fallback_memory");
    }
    noteSocketIoRedisAdapterFallback();
    attachInMemoryAdapter(io);
    scheduleReconnect();
    return;
  }

  pubClient = clients.pub;
  subClient = clients.sub;
  io.adapter(createAdapter(clients.pub, clients.sub, buildSocketIoRedisAdapterOptions()));
  if (!attachedForCurrentGeneration) {
    noteSocketIoRedisAdapterAttachedServer();
    attachedForCurrentGeneration = true;
  }
  resetReconnectBackoff();
  noteSocketIoRedisAdapterConnected();
  logger.info("socket_io_redis_adapter_connected");
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
