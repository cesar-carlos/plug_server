/**
 * Minimal `/consumers` client for hub → agent command paths (same entry as real consumers).
 */

import { io as ioClient, type Socket as IoSocket } from "socket.io-client";

export const connectConsumerSocket = (baseUrl: string, accessToken: string): Promise<IoSocket> => {
  return new Promise<IoSocket>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token: accessToken },
      transports: ["websocket"],
    });
    socket.on("connection:ready", () => resolve(socket));
    socket.on("connect_error", (err) => {
      socket.disconnect();
      reject(err);
    });
  });
};
