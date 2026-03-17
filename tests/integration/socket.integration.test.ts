import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer } from "../helpers/test_server";

const connectConsumer = (baseUrl: string, token: string) =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token },
      transports: ["websocket"],
    });
    socket.on("connection:ready", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });

describe("Socket namespaces", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();

    const registerRes = await request(baseUrl)
      .post("/api/v1/auth/register")
      .send({ email: "socket@test.com", password: "SocketTest1" });

    expect(registerRes.status).toBe(201);
    accessToken = registerRes.body.accessToken as string;
  });

  afterAll(async () => {
    await server.close();
  });

  describe("/consumers namespace", () => {
    it("should connect with valid user token and receive connection:ready", async () => {
      const socket = await connectConsumer(baseUrl, accessToken);
      expect(socket.connected).toBe(true);
      socket.disconnect();
    });

    it("should reject connection without token when auth is required", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = ioClient(`${baseUrl}/consumers`, { transports: ["websocket"] });
          socket.on("connect_error", (err) => {
            expect(err.message).toBeDefined();
            socket.disconnect();
            resolve();
          });
          socket.on("connection:ready", () => {
            socket.disconnect();
            reject(new Error("Expected connection to be rejected"));
          });
        }),
      ).resolves.toBeUndefined();
    });

    it("should respond to agents:command with validation error for invalid payload", async () => {
      const socket = await connectConsumer(baseUrl, accessToken);

      const response = await new Promise<{ success: boolean; error?: { code: string } }>((resolve) => {
        socket.on("agents:command_response", resolve);
        socket.emit("agents:command", { agentId: "invalid", command: {} });
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBeDefined();
      socket.disconnect();
    });

    it("should respond to agents:command with agent not found for non-existent agent", async () => {
      const socket = await connectConsumer(baseUrl, accessToken);

      const response = await new Promise<{ success: boolean; error?: { code: string } }>((resolve) => {
        socket.on("agents:command_response", resolve);
        socket.emit("agents:command", {
          agentId: "00000000-0000-0000-0000-000000000000",
          command: {
            jsonrpc: "2.0",
            method: "sql.execute",
            params: { sql: "SELECT 1", client_token: "test" },
          },
        });
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toMatch(/NOT_FOUND|COMMAND_FAILED/);
      socket.disconnect();
    });
  });

  describe("/agents namespace", () => {
    it("should reject user token (role user) from /agents", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = ioClient(`${baseUrl}/agents`, {
            auth: { token: accessToken },
            transports: ["websocket"],
          });
          socket.on("connect_error", () => {
            socket.disconnect();
            resolve();
          });
          socket.on("connection:ready", () => {
            socket.disconnect();
            reject(new Error("Expected connection to be rejected for user role in /agents"));
          });
        }),
      ).resolves.toBeUndefined();
    });
  });
});
