import { createServer } from "node:http";

import { createApp } from "./app";
import { prismaClient } from "./infrastructure/database/prisma/client";
import { createSocketServer } from "./socket";
import { env } from "./shared/config/env";
import { logger } from "./shared/utils/logger";

const app = createApp();
const httpServer = createServer(app);
const io = createSocketServer(httpServer);

httpServer.listen(env.port, "0.0.0.0", () => {
  logger.info("HTTP server started", {
    appName: env.appName,
    port: env.port,
    environment: env.nodeEnv,
  });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info("Shutdown signal received", { signal });
  io.close();
  await prismaClient.$disconnect();
  httpServer.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
