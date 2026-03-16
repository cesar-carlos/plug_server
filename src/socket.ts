import type { Server as HttpServer } from "node:http";

import { Server } from "socket.io";

import { authenticateSocket } from "./presentation/socket/auth/socket_auth.middleware";
import { env } from "./shared/config/env";
import { socketEvents } from "./shared/constants/socket_events";
import { logger } from "./shared/utils/logger";

export const createSocketServer = (httpServer: HttpServer): Server => {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin,
    },
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    logger.info("Socket client connected", {
      socketId: socket.id,
      userId: typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null,
    });

    socket.emit(socketEvents.connectionReady, {
      id: socket.id,
      message: "Socket connected successfully",
      user: socket.data.user ?? null,
    });
  });

  return io;
};
