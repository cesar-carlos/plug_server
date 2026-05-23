import { createServer, type Server as HttpServer } from "node:http";

import type { Namespace, Server as SocketIoServer, Socket } from "socket.io";

import { prismaClient } from "../../../src/infrastructure/database/prisma/client";
import {
  closeClientSocketEventPublishIdempotencyRedis,
  initClientSocketEventPublishIdempotencyRedis,
} from "../../../src/infrastructure/redis/client_socket_event_publish_idempotency_redis";
import {
  closeSocketIoRedisAdapter,
  initSocketIoRedisAdapter,
} from "../../../src/infrastructure/redis/socket_io_redis_adapter";
import { closeSocketServer, createSocketServer } from "../../../src/socket";

let httpServer: HttpServer | undefined;
let io: SocketIoServer | undefined;
let shuttingDown = false;
let injectFetchSocketsFailure = false;

const writeStdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const getTestNamespace = (
  socketServer: SocketIoServer,
): Namespace<Record<string, never>, Record<string, never>, Record<string, never>, never> =>
  socketServer.of("/__test");

const patchConsumersFetchSockets = (socketServer: SocketIoServer): void => {
  const adapter = socketServer.of("/consumers").adapter as object;
  const prototype = Object.getPrototypeOf(adapter) as {
    fetchSockets?: (...args: unknown[]) => Promise<unknown[]>;
    __integrationFetchSocketsPatched?: boolean;
  };
  if (prototype.__integrationFetchSocketsPatched || typeof prototype.fetchSockets !== "function") {
    return;
  }

  const originalFetchSockets = prototype.fetchSockets;
  prototype.fetchSockets = async function (this: unknown, ...args: unknown[]): Promise<unknown[]> {
    if (injectFetchSocketsFailure) {
      throw new Error("integration_test_fetch_sockets_injected_failure");
    }
    return originalFetchSockets.apply(this, args);
  };
  Object.defineProperty(prototype, "__integrationFetchSocketsPatched", { value: true });
};

const bindTestNamespace = (socketServer: SocketIoServer): void => {
  getTestNamespace(socketServer).on("connection", (socket: Socket) => {
    socket.on(
      "room-count",
      (payload: { room?: unknown }, ack?: (response: { count: number }) => void) => {
        const room = typeof payload?.room === "string" ? payload.room.trim() : "";
        const count =
          room === "" ? 0 : (socketServer.of("/consumers").adapter.rooms.get(room)?.size ?? 0);
        ack?.({ count });
      },
    );
    socket.on(
      "set-fetch-sockets-failure",
      (payload: { enabled?: unknown }, ack?: (response: { enabled: boolean }) => void) => {
        injectFetchSocketsFailure = payload?.enabled === true;
        ack?.({ enabled: injectFetchSocketsFailure });
      },
    );
  });
};

const closeHttpServer = async (): Promise<void> => {
  if (httpServer === undefined) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer?.close((error) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ERR_SERVER_NOT_RUNNING" || error.message?.includes("not running")) {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const shutdown = async (): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  try {
    if (io !== undefined) {
      await closeSocketServer(io, "distributed_test_child_shutdown");
      io = undefined;
    }
    await closeHttpServer();
    await closeSocketIoRedisAdapter();
    await closeClientSocketEventPublishIdempotencyRedis();
    await prismaClient.$disconnect();
    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(`TEST_SERVER_ERROR ${message}`);
    process.exit(1);
  }
};

const bootstrap = async (): Promise<void> => {
  await initClientSocketEventPublishIdempotencyRedis();

  const { registerHttpRateLimits } =
    await import("../../../src/presentation/http/middlewares/rate_limit.middleware");
  registerHttpRateLimits();

  const { createApp } = await import("../../../src/app");
  const app = createApp();
  httpServer = createServer(app);
  io = createSocketServer(httpServer);
  bindTestNamespace(io);
  await initSocketIoRedisAdapter(io);
  patchConsumersFetchSockets(io);

  await new Promise<void>((resolve, reject) => {
    httpServer?.listen(0, "127.0.0.1", () => resolve());
    httpServer?.once("error", reject);
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve child test server address");
  }

  writeStdoutLine(`TEST_SERVER_READY http://127.0.0.1:${address.port}`);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

void bootstrap().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeStderrLine(`TEST_SERVER_ERROR ${message}`);
  await shutdown();
});
