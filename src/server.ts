import { createServer } from "node:http";

import { createApp } from "./app";
import {
  flushPendingSocketAuditEvents,
  waitForSocketAuditDrain,
  startSocketAuditRetentionScheduler,
  stopSocketAuditRetentionScheduler,
} from "./application/services/socket_audit.service";
import { prismaClient } from "./infrastructure/database/prisma/client";
import { closeSocketServer, createSocketServer } from "./socket";
import { env } from "./shared/config/env";
import { logger } from "./shared/utils/logger";

const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);

startSocketAuditRetentionScheduler({
  retentionDays: env.socketAuditRetentionDays,
  intervalMs: env.socketAuditRetentionIntervalMinutes * 60 * 1000,
  batchSize: env.socketAuditPruneBatchSize,
});

httpServer.listen(env.port, "0.0.0.0", () => {
  logger.info("HTTP server started", {
    appName: env.appName,
    port: env.port,
    environment: env.nodeEnv,
  });
});

let shutdownInProgress = false;

const closeHttpServer = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const shutdown = async (signal: string): Promise<void> => {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  logger.info("Shutdown signal received", { signal });

  try {
    stopSocketAuditRetentionScheduler();
    await flushPendingSocketAuditEvents();
    const auditDrain = await waitForSocketAuditDrain(2_500);
    if (!auditDrain.drained) {
      logger.warn("socket_audit_drain_timeout", { pending: auditDrain.pending });
    }

    await closeSocketServer(io, signal);
    await closeHttpServer();
    await prismaClient.$disconnect();
    logger.info("Shutdown completed", { signal });
    process.exit(0);
  } catch (error: unknown) {
    logger.error("Shutdown failed", {
      signal,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
