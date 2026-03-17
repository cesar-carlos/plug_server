/**
 * Test helper to create HTTP + Socket.IO server for integration tests.
 */

import { createServer } from "node:http";

import type { Server as HttpServer } from "node:http";
import type { Server as SocketServer } from "socket.io";

import { createApp } from "../../src/app";
import { createSocketServer } from "../../src/socket";

export interface TestServerResult {
  readonly httpServer: HttpServer;
  readonly close: () => Promise<void>;
  readonly getUrl: () => string;
}

export const createTestServer = (): Promise<TestServerResult> => {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const httpServer = createServer(app);
    const io: SocketServer = createSocketServer(httpServer);

    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = address.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      resolve({
        httpServer,
        getUrl: () => baseUrl,
        close: () =>
          new Promise<void>((closeResolve) => {
            io.close(() => {
              httpServer.close(() => closeResolve());
            });
          }),
      });
    });

    httpServer.on("error", reject);
  });
};
