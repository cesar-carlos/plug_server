import { randomUUID } from "node:crypto";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../src/shared/utils/rpc_types";
import { env } from "../../src/shared/config/env";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { User } from "../../src/domain/entities/user.entity";

const testAgentId = "5b9ae809-4e2f-454f-8967-f0b535d5e8f5";
const repositories = getTestRepositoryAccess();
const makeLargeText = (length: number): string => {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_!@#$%^&*()+=[]{}";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[(index * 17) % alphabet.length];
  }
  return output;
};

const connectConsumer = (
  baseUrl: string,
  token: string,
): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/consumers`, {
      auth: { token },
      transports: ["websocket"],
    });
    socket.on("connection:ready", (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        reject(new Error(`Failed to decode connection:ready: ${decoded.error.message}`));
        return;
      }
      resolve(socket);
    });
    socket.on("connect_error", (err) => reject(err));
  });

const connectAgent = (baseUrl: string, token: string): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agents`, {
      auth: { token },
      transports: ["websocket"],
    });
    socket.on("connection:ready", (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        reject(new Error(`Failed to decode connection:ready: ${decoded.error.message}`));
        return;
      }
      resolve(socket);
    });
    socket.on("connect_error", (err) => reject(err));
  });

const waitForEvent = <T>(
  socket: ReturnType<typeof ioClient>,
  eventName: string,
  timeoutMs = 5_000,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const onEvent = (payload: T): void => {
      clearTimeout(timeout);
      socket.off(eventName, onEvent);
      resolve(payload);
    };

    socket.on(eventName, onEvent);
  });

const registerAgentAndWaitReady = async (
  socket: ReturnType<typeof ioClient>,
  capabilities: Record<string, unknown>,
  agentId = testAgentId,
): Promise<void> => {
  const capabilitiesPromise = waitForEvent<unknown>(socket, "agent:capabilities");
  socket.emit(
    "agent:register",
    encodePayloadFrame({
      agentId,
      capabilities,
      timestamp: new Date().toISOString(),
    }),
  );
  await capabilitiesPromise;
  if (env.socketAgentProtocolReadyGraceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.socketAgentProtocolReadyGraceMs));
  }
};

const createAdminAccessToken = async (baseUrl: string): Promise<string> => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const email = `socket-admin-${unique}@test.com`;
  const password = "SocketAdmin1";
  const registerRes = await request(baseUrl).post("/api/v1/auth/register").send({ email, password });
  expect(registerRes.status).toBe(201);
  await approveRegistrationByToken(baseUrl, registerRes.body.approvalToken as string);
  const userId = registerRes.body.user.id as string;
  const currentUser = await repositories.user.findById(userId);
  expect(currentUser).not.toBeNull();
  await repositories.user.save(
    User.create({
      id: userId,
      email,
      passwordHash: currentUser!.passwordHash,
      role: "admin",
      status: "active",
      createdAt: currentUser!.createdAt,
      ...(currentUser!.celular !== undefined ? { celular: currentUser!.celular } : {}),
    }),
  );
  const loginRes = await request(baseUrl).post("/api/v1/auth/login").send({
    email,
    password,
  });
  expect(loginRes.status).toBe(200);
  return loginRes.body.accessToken as string;
};

describe("Socket namespaces", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl: string;
  let accessToken: string;
  let clientAccessToken: string;
  let clientId: string;
  let agentAccessToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();

    const registerRes = await request(baseUrl)
      .post("/api/v1/auth/register")
      .send({ email: "socket@test.com", password: "SocketTest1" });

    expect(registerRes.status).toBe(201);
    await approveRegistrationByToken(baseUrl, registerRes.body.approvalToken as string);

    const userLoginRes = await request(baseUrl).post("/api/v1/auth/login").send({
      email: "socket@test.com",
      password: "SocketTest1",
    });
    expect(userLoginRes.status).toBe(200);
    accessToken = userLoginRes.body.accessToken as string;

    const userId: string = registerRes.body.user.id as string;
    await seedAgent({
      agentId: testAgentId,
      name: "Socket Test Agent",
      cnpjCpf: `socket-test-${userId.slice(0, 8)}`,
    });
    await seedAgentBinding(userId, testAgentId);

    const clientRegisterRes = await request(baseUrl)
      .post("/api/v1/client-auth/register")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        email: "socket-client@test.com",
        password: "SocketClient1",
        name: "Socket",
        lastName: "Client",
      });
    expect(clientRegisterRes.status).toBe(201);
    clientId = clientRegisterRes.body.client.id as string;
    clientAccessToken = clientRegisterRes.body.accessToken as string;

    const agentLoginRes = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: "socket@test.com",
      password: "SocketTest1",
      agentId: testAgentId,
    });

    expect(agentLoginRes.status).toBe(200);
    agentAccessToken = agentLoginRes.body.accessToken as string;
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

      const response = await new Promise<{ success: boolean; error?: { code: string } }>(
        (resolve) => {
          socket.on("agents:command_response", resolve);
          socket.emit("agents:command", { agentId: "invalid", command: {} });
        },
      );

      expect(response.success).toBe(false);
      expect(response.error?.code).toBeDefined();
      socket.disconnect();
    });

    it("should deny client agents:command when client has no approved access", async () => {
      if (!env.socketConsumerRoles.includes("client")) {
        return;
      }
      const socket = await connectConsumer(baseUrl, clientAccessToken);

      const response = await new Promise<{
        success: boolean;
        error?: { code?: string; statusCode?: number };
      }>((resolve) => {
        socket.on("agents:command_response", resolve);
        socket.emit("agents:command", {
          agentId: testAgentId,
          command: {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "client-denied-1",
            params: { sql: "SELECT 1", client_token: "client-test-token" },
          },
        });
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe("AGENT_ACCESS_DENIED");
      expect(response.error?.statusCode).toBe(403);
      socket.disconnect();
    });

    it("should allow relay conversation for client when access is approved", async () => {
      if (!env.socketConsumerRoles.includes("client")) {
        return;
      }
      await repositories.clientAgentAccess.addAccess(clientId, testAgentId, new Date());
      const clientSocket = await connectConsumer(baseUrl, clientAccessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        });

        const startedPromise = waitForEvent<{
          success: boolean;
          conversationId?: string;
          agentId?: string;
          error?: { code?: string };
        }>(clientSocket, "relay:conversation.started");

        clientSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);
        expect(started.conversationId).toBeDefined();
        expect(started.agentId).toBe(testAgentId);
      } finally {
        clientSocket.disconnect();
        agentSocket.disconnect();
      }
    });

    it("should allow relay conversation for admin without explicit ownership link", async () => {
      if (!env.socketConsumerRoles.includes("admin")) {
        return;
      }
      const adminAccessToken = await createAdminAccessToken(baseUrl);
      const adminSocket = await connectConsumer(baseUrl, adminAccessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        });

        const startedPromise = waitForEvent<{
          success: boolean;
          conversationId?: string;
          agentId?: string;
          error?: { code?: string };
        }>(adminSocket, "relay:conversation.started");
        adminSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);
        expect(started.agentId).toBe(testAgentId);
      } finally {
        adminSocket.disconnect();
        agentSocket.disconnect();
      }
    });

    it("should deny new relay rpc requests after client access is revoked", async () => {
      if (!env.socketConsumerRoles.includes("client")) {
        return;
      }
      await repositories.clientAgentAccess.addAccess(clientId, testAgentId, new Date());
      const clientSocket = await connectConsumer(baseUrl, clientAccessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        });

        const startedPromise = waitForEvent<{
          success: boolean;
          conversationId?: string;
        }>(clientSocket, "relay:conversation.started");
        clientSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);
        expect(started.conversationId).toBeDefined();

        await repositories.clientAgentAccess.removeAccess(clientId, testAgentId);

        const accepted = await new Promise<{
          success: boolean;
          error?: { code?: string; statusCode?: number };
        }>((resolve) => {
          clientSocket.once("relay:rpc.accepted", resolve);
          clientSocket.emit("relay:rpc.request", {
            conversationId: started.conversationId,
            frame: encodePayloadFrame({
              jsonrpc: "2.0",
              id: "revoked-client-request",
              method: "sql.execute",
              params: { sql: "SELECT 1", client_token: "revoked-test-token" },
            }),
          });
        });

        expect(accepted.success).toBe(false);
        expect(accepted.error?.code).toBe("AGENT_ACCESS_DENIED");
        expect(accepted.error?.statusCode).toBe(403);
      } finally {
        clientSocket.disconnect();
        agentSocket.disconnect();
      }
    });

    it("should respond to agents:command with agent not found for non-existent agent", async () => {
      const socket = await connectConsumer(baseUrl, accessToken);

      const response = await new Promise<{ success: boolean; error?: { code: string } }>(
        (resolve) => {
          socket.on("agents:command_response", resolve);
          socket.emit("agents:command", {
            agentId: "00000000-0000-0000-0000-000000000000",
            command: {
              jsonrpc: "2.0",
              method: "sql.execute",
              params: { sql: "SELECT 1", client_token: "test" },
            },
          });
        },
      );

      expect(response.success).toBe(false);
      expect(response.error?.code).toMatch(/NOT_FOUND|COMMAND_FAILED/);
      socket.disconnect();
    });

    it("should assign JSON-RPC id for agents:command without id and return normalized success", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        });

        const rpcHandled = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for rpc:request")),
            8_000,
          );

          agentSocket.once("rpc:request", (rawPayload: unknown) => {
            const decoded = decodePayloadFrame(rawPayload);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(timeout);
              reject(new Error("Invalid rpc:request payload"));
              return;
            }

            const wireId = toRequestId(decoded.value.data.id);
            if (!wireId || !/^[0-9a-f-]{36}$/i.test(wireId)) {
              clearTimeout(timeout);
              reject(new Error("Expected auto-generated UUID in command.id"));
              return;
            }

            agentSocket.emit(
              "rpc:response",
              encodePayloadFrame({
                jsonrpc: "2.0",
                id: wireId,
                result: { ok: true, via: "socket-bridge-auto-id" },
              }),
            );

            clearTimeout(timeout);
            resolve();
          });
        });

        const commandResponsePromise = waitForEvent<{
          success: boolean;
          requestId?: string;
          response?: { type?: string; item?: { result?: { via?: string } } };
        }>(consumerSocket, "agents:command_response");

        consumerSocket.emit("agents:command", {
          agentId: testAgentId,
          command: {
            jsonrpc: "2.0",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
              client_token: "token-value",
            },
          },
        });

        const [, response] = await Promise.all([rpcHandled, commandResponsePromise]);

        expect(response.success).toBe(true);
        expect(response.requestId).toBeDefined();
        expect(response.response?.type).toBe("single");
        expect(response.response?.item?.result?.via).toBe("socket-bridge-auto-id");
      } finally {
        consumerSocket.disconnect();
        agentSocket.disconnect();
      }
    });

    it("should stream agent chunks to consumer and allow stream pull", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        let streamIdForTest = "";
        let requestIdForTest = "";
        let pullCount = 0;

        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
          },
        });

        const pullPayloadPromise = waitForEvent<unknown>(agentSocket, "rpc:stream.pull");
        const commandResponsePromise = waitForEvent<{
          success: boolean;
          requestId?: string;
          streamId?: string;
          response?: Record<string, unknown>;
        }>(consumerSocket, "agents:command_response");
        const chunkEventsPromise = new Promise<readonly Record<string, unknown>[]>(
          (resolve, reject) => {
            const collected: Record<string, unknown>[] = [];
            const timeout = setTimeout(() => {
              consumerSocket.off("agents:command_stream_chunk", onChunk);
              reject(new Error("Timed out waiting for stream chunk events"));
            }, 8_000);

            const onChunk = (payload: Record<string, unknown>): void => {
              collected.push(payload);

              if (collected.length >= 1) {
                clearTimeout(timeout);
                consumerSocket.off("agents:command_stream_chunk", onChunk);
                resolve(collected);
              }
            };

            consumerSocket.on("agents:command_stream_chunk", onChunk);
          },
        );
        const completeEventPromise = waitForEvent<Record<string, unknown>>(
          consumerSocket,
          "agents:command_stream_complete",
        );
        const pullResponsePromise = waitForEvent<{
          success: boolean;
          requestId?: string;
          streamId?: string;
          windowSize?: number;
        }>(consumerSocket, "agents:stream_pull_response");

        agentSocket.on("rpc:request", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }
          requestIdForTest = requestId;
          streamIdForTest = `stream-${requestId}`;

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame({
              jsonrpc: "2.0",
              id: requestId,
              result: {
                stream_id: streamIdForTest,
                row_count: 0,
              },
            }),
          );

          agentSocket.emit(
            "rpc:chunk",
            encodePayloadFrame({
              stream_id: streamIdForTest,
              request_id: requestId,
              chunk_index: 0,
              rows: [{ id: 1, name: "alpha" }],
            }),
          );
        });

        pullPayloadPromise.then((payload) => {
          const decoded = decodePayloadFrame(payload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const receivedRequestId = toRequestId(decoded.value.data.request_id);
          const receivedStreamId = toRequestId(decoded.value.data.stream_id);
          if (!receivedRequestId || !receivedStreamId) {
            return;
          }
          pullCount += 1;

          agentSocket.emit(
            "rpc:chunk",
            encodePayloadFrame({
              stream_id: receivedStreamId,
              request_id: receivedRequestId,
              chunk_index: 1,
              rows: [{ id: 2, name: "beta" }],
            }),
          );

          agentSocket.emit(
            "rpc:complete",
            encodePayloadFrame({
              stream_id: receivedStreamId,
              request_id: receivedRequestId,
              total_rows: 2,
            }),
          );
        });

        consumerSocket.emit("agents:command", {
          agentId: testAgentId,
          command: {
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "stream-request-1",
            params: {
              sql: "SELECT * FROM users ORDER BY id",
              client_token: "token-value",
            },
          },
        });

        const commandResponse = await commandResponsePromise;
        expect(commandResponse.success).toBe(true);
        expect(commandResponse.requestId).toBeDefined();
        expect(commandResponse.streamId).toBeDefined();

        streamIdForTest = commandResponse.streamId ?? "";
        requestIdForTest = commandResponse.requestId ?? "";
        expect(requestIdForTest).not.toBe("");

        consumerSocket.emit("agents:stream_pull", {
          requestId: requestIdForTest,
          windowSize: 2,
        });

        const [pullResponse, pullPayloadRaw] = await Promise.all([
          pullResponsePromise,
          pullPayloadPromise,
        ]);
        expect(pullResponse.success).toBe(true);
        expect(pullResponse.streamId).toBe(streamIdForTest);
        expect(pullResponse.windowSize).toBe(2);

        const decodedPullPayload = decodePayloadFrame(pullPayloadRaw);
        expect(decodedPullPayload.ok).toBe(true);
        const pullPayload =
          decodedPullPayload.ok && isRecord(decodedPullPayload.value.data)
            ? decodedPullPayload.value.data
            : null;
        expect(pullPayload).not.toBeNull();

        const [chunkEvents, completeEvent] = await Promise.all([
          chunkEventsPromise,
          completeEventPromise,
        ]);

        expect(commandResponse.streamId).toBe(streamIdForTest);

        expect(toRequestId(pullPayload?.request_id)).toBe(requestIdForTest);
        expect(toRequestId(pullPayload?.stream_id)).toBe(streamIdForTest);
        expect(pullPayload?.window_size).toBe(2);

        expect(chunkEvents.length).toBeGreaterThanOrEqual(1);
        expect(toRequestId(chunkEvents[0]?.request_id)).toBe(requestIdForTest);
        expect(toRequestId(completeEvent.request_id)).toBe(requestIdForTest);
        expect(toRequestId(completeEvent.stream_id)).toBe(streamIdForTest);
        expect(pullCount).toBe(1);
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should isolate relay conversations for multiple consumers connected to the same agent", async () => {
      const consumerA = await connectConsumer(baseUrl, accessToken);
      const consumerB = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
          },
        });

        const startedA = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerA,
          "relay:conversation.started",
        );
        consumerA.emit("relay:conversation.start", { agentId: testAgentId });

        const startedB = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerB,
          "relay:conversation.started",
        );
        consumerB.emit("relay:conversation.start", { agentId: testAgentId });

        const [conversationA, conversationB] = await Promise.all([startedA, startedB]);
        expect(conversationA.success).toBe(true);
        expect(conversationB.success).toBe(true);
        expect(conversationA.conversationId).not.toBe(conversationB.conversationId);

        let foreignMessageInA = false;
        let foreignMessageInB = false;

        consumerA.on("relay:rpc.response", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const result = isRecord(decoded.value.data.result) ? decoded.value.data.result : null;
          const responseConversationId = toRequestId(result?.conversation_id);
          if (responseConversationId && responseConversationId !== conversationA.conversationId) {
            foreignMessageInA = true;
          }
        });

        consumerB.on("relay:rpc.response", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const result = isRecord(decoded.value.data.result) ? decoded.value.data.result : null;
          const responseConversationId = toRequestId(result?.conversation_id);
          if (responseConversationId && responseConversationId !== conversationB.conversationId) {
            foreignMessageInB = true;
          }
        });

        agentSocket.on("rpc:request", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }

          const meta = isRecord(decoded.value.data.meta) ? decoded.value.data.meta : null;
          const conversationId = toRequestId(meta?.conversation_id);
          if (!conversationId) {
            return;
          }

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame({
              jsonrpc: "2.0",
              id: requestId,
              result: {
                conversation_id: conversationId,
                ok: true,
              },
            }),
          );
        });

        const acceptedA = waitForEvent<{ success: boolean; requestId?: string }>(
          consumerA,
          "relay:rpc.accepted",
        );
        const acceptedB = waitForEvent<{ success: boolean; requestId?: string }>(
          consumerB,
          "relay:rpc.accepted",
        );
        const responseA = waitForEvent<unknown>(consumerA, "relay:rpc.response", 8_000);
        const responseB = waitForEvent<unknown>(consumerB, "relay:rpc.response", 8_000);

        consumerA.emit("relay:rpc.request", {
          conversationId: conversationA.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
              client_token: "token-a",
            },
          }),
        });
        consumerB.emit("relay:rpc.request", {
          conversationId: conversationB.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
              client_token: "token-b",
            },
          }),
        });

        const [acceptedPayloadA, acceptedPayloadB, rawResponseA, rawResponseB] = await Promise.all([
          acceptedA,
          acceptedB,
          responseA,
          responseB,
        ]);
        expect(acceptedPayloadA.success).toBe(true);
        expect(acceptedPayloadB.success).toBe(true);

        const decodedA = decodePayloadFrame(rawResponseA);
        const decodedB = decodePayloadFrame(rawResponseB);
        expect(decodedA.ok).toBe(true);
        expect(decodedB.ok).toBe(true);

        const responseDataA =
          decodedA.ok && isRecord(decodedA.value.data) ? decodedA.value.data : null;
        const responseDataB =
          decodedB.ok && isRecord(decodedB.value.data) ? decodedB.value.data : null;
        const resultA =
          responseDataA && isRecord(responseDataA.result) ? responseDataA.result : null;
        const resultB =
          responseDataB && isRecord(responseDataB.result) ? responseDataB.result : null;

        expect(toRequestId(resultA?.conversation_id)).toBe(conversationA.conversationId);
        expect(toRequestId(resultB?.conversation_id)).toBe(conversationB.conversationId);

        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        expect(foreignMessageInA).toBe(false);
        expect(foreignMessageInB).toBe(false);
      } finally {
        agentSocket.disconnect();
        consumerA.disconnect();
        consumerB.disconnect();
      }
    });

    it("should relay execution_mode preserve and normalize preserve_sql before sending to agent", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
        });

        const startedPromise = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerSocket,
          "relay:conversation.started",
        );
        consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);

        const acceptedPromise = waitForEvent<{ success: boolean }>(
          consumerSocket,
          "relay:rpc.accepted",
        );
        const rpcRequestPromise = waitForEvent<unknown>(agentSocket, "rpc:request", 8_000);
        const responsePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.response", 8_000);

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            method: "sql.execute",
            id: "relay-exec-mode-1",
            params: {
              sql: "SELECT 1",
              client_token: "token",
              options: { execution_mode: "preserve" },
            },
          }),
        });

        const [accepted, rawPayload] = await Promise.all([acceptedPromise, rpcRequestPromise]);
        expect(accepted.success).toBe(true);

        const decoded = decodePayloadFrame(rawPayload);
        expect(decoded.ok).toBe(true);
        const data = decoded.ok && isRecord(decoded.value.data) ? decoded.value.data : null;
        const params = data && isRecord(data.params) ? data.params : {};
        const options = isRecord(params.options) ? params.options : {};
        expect(options.execution_mode).toBe("preserve");

        const requestId = toRequestId(data?.id);
        expect(requestId).toBeDefined();

        agentSocket.emit(
          "rpc:response",
          encodePayloadFrame({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              execution_id: "exec-relay-1",
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
              sql_handling_mode: "preserve",
              rows: [],
              row_count: 0,
              affected_rows: 0,
              column_metadata: [],
            },
          }),
        );

        const response = await responsePromise;
        const responseDecoded = decodePayloadFrame(response);
        expect(responseDecoded.ok).toBe(true);
        const result =
          responseDecoded.ok && isRecord(responseDecoded.value.data)
            ? responseDecoded.value.data.result
            : null;
        expect(isRecord(result) ? result.sql_handling_mode : null).toBe("preserve");
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should deduplicate relay requests with the same client request id in a conversation", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
          },
        });

        const startedPromise = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerSocket,
          "relay:conversation.started",
        );
        consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);

        let rpcRequestCount = 0;
        agentSocket.on("rpc:request", (rawPayload: unknown) => {
          rpcRequestCount += 1;

          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }
          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame({
              jsonrpc: "2.0",
              id: requestId,
              result: {
                ok: true,
              },
            }),
          );
        });

        const acceptedFirst = waitForEvent<{
          success: boolean;
          requestId?: string;
          deduplicated?: boolean;
        }>(consumerSocket, "relay:rpc.accepted");
        const responsePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.response", 8_000);

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            id: "client-dup-1",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
              client_token: "dup-token",
            },
          }),
        });

        const firstAccepted = await acceptedFirst;
        expect(firstAccepted.success).toBe(true);
        expect(firstAccepted.requestId).toBeDefined();
        expect(firstAccepted.deduplicated).not.toBe(true);

        const acceptedSecond = waitForEvent<{
          success: boolean;
          requestId?: string;
          deduplicated?: boolean;
        }>(consumerSocket, "relay:rpc.accepted");

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            id: "client-dup-1",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
              client_token: "dup-token",
            },
          }),
        });

        const secondAccepted = await acceptedSecond;
        expect(secondAccepted.success).toBe(true);
        expect(secondAccepted.requestId).toBe(firstAccepted.requestId);
        expect(secondAccepted.deduplicated).toBe(true);

        await responsePromise;
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        expect(rpcRequestCount).toBe(1);
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should support relay contract with gzip frames, ack and stream pull", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["gzip", "none"],
          extensions: {
            streamingResults: true,
          },
        });

        const startedPromise = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerSocket,
          "relay:conversation.started",
        );
        consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);

        let routedRequestId = "";
        let streamId = "";

        agentSocket.on("rpc:request", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }
          routedRequestId = requestId;
          streamId = `stream-${requestId}`;

          agentSocket.emit(
            "rpc:request_ack",
            encodePayloadFrame(
              {
                request_id: requestId,
                status: "accepted",
              },
              { compressionThreshold: 1 },
            ),
          );

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame(
              {
                jsonrpc: "2.0",
                id: requestId,
                result: {
                  stream_id: streamId,
                  note: makeLargeText(2500),
                },
              },
              { compressionThreshold: 1 },
            ),
          );

          agentSocket.emit(
            "rpc:chunk",
            encodePayloadFrame(
              {
                stream_id: streamId,
                request_id: requestId,
                chunk_index: 0,
                rows: [{ row: 1, payload: makeLargeText(2600) }],
              },
              { compressionThreshold: 1 },
            ),
          );
        });

        const acceptedPromise = waitForEvent<{
          success: boolean;
          requestId?: string;
          error?: { code?: string; message?: string; statusCode?: number };
        }>(consumerSocket, "relay:rpc.accepted");
        const ackPromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.request_ack");
        const responsePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.response");

        const receivedChunks: unknown[] = [];
        consumerSocket.on("relay:rpc.chunk", (payload: unknown) => {
          receivedChunks.push(payload);
        });

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame(
            {
              jsonrpc: "2.0",
              id: "client-relay-gzip-1",
              method: "sql.execute",
              params: {
                sql: "SELECT * FROM users",
                client_token: "relay-gzip-token",
                params: { placeholder: makeLargeText(4000) },
              },
            },
            { compressionThreshold: 1 },
          ),
        });

        const accepted = await acceptedPromise;
        if (!accepted.success) {
          throw new Error(`relay:rpc.accepted failed: ${JSON.stringify(accepted.error ?? null)}`);
        }
        expect(accepted.success).toBe(true);
        expect(accepted.requestId).toBeDefined();

        const [rawAck, rawResponse] = await Promise.all([ackPromise, responsePromise]);
        const decodedAck = decodePayloadFrame(rawAck);
        const decodedResponse = decodePayloadFrame(rawResponse);

        expect(decodedAck.ok).toBe(true);
        expect(decodedResponse.ok).toBe(true);
        if (decodedAck.ok) {
          expect(decodedAck.value.frame.cmp).toBe("none");
        }
        if (decodedResponse.ok) {
          expect(decodedResponse.value.frame.cmp).toBe("gzip");
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(receivedChunks.length).toBe(0);

        const pullResponsePromise = waitForEvent<{
          success: boolean;
          requestId?: string;
          streamId?: string;
          windowSize?: number;
        }>(consumerSocket, "relay:rpc.stream.pull_response");
        const agentPullPayloadPromise = waitForEvent<unknown>(agentSocket, "rpc:stream.pull");
        const completePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.complete", 8_000);

        consumerSocket.emit("relay:rpc.stream.pull", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame(
            {
              request_id: accepted.requestId,
              window_size: 2,
            },
            { compressionThreshold: 1 },
          ),
        });

        const pullResponse = await pullResponsePromise;
        expect(pullResponse.success).toBe(true);
        expect(pullResponse.windowSize).toBe(2);

        const rawAgentPull = await agentPullPayloadPromise;
        const decodedAgentPull = decodePayloadFrame(rawAgentPull);
        expect(decodedAgentPull.ok).toBe(true);

        agentSocket.emit(
          "rpc:chunk",
          encodePayloadFrame(
            {
              stream_id: streamId,
              request_id: routedRequestId,
              chunk_index: 1,
              rows: [{ row: 2, payload: makeLargeText(2200) }],
            },
            { compressionThreshold: 1 },
          ),
        );
        agentSocket.emit(
          "rpc:complete",
          encodePayloadFrame(
            {
              stream_id: streamId,
              request_id: routedRequestId,
              total_rows: 2,
            },
            { compressionThreshold: 1 },
          ),
        );

        const rawComplete = await completePromise;
        const decodedComplete = decodePayloadFrame(rawComplete);
        expect(decodedComplete.ok).toBe(true);
        if (decodedComplete.ok) {
          expect(decodedComplete.value.frame.cmp).toBe("none");
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(receivedChunks.length).toBeGreaterThanOrEqual(2);
        const decodedFirstChunk = decodePayloadFrame(receivedChunks[0]);
        expect(decodedFirstChunk.ok).toBe(true);
        if (decodedFirstChunk.ok) {
          expect(decodedFirstChunk.value.frame.cmp).toBe("gzip");
          const firstChunkPayload = isRecord(decodedFirstChunk.value.data)
            ? decodedFirstChunk.value.data
            : null;
          expect(toRequestId(firstChunkPayload?.request_id)).toBe(accepted.requestId);
        }
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should clamp relay stream pull window using agent advertised capability", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
            recommendedStreamPullWindowSize: 2,
            maxStreamPullWindowSize: 2,
          },
        });

        const startedPromise = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerSocket,
          "relay:conversation.started",
        );
        consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);

        const acceptedPromise = waitForEvent<{ success: boolean; requestId?: string }>(
          consumerSocket,
          "relay:rpc.accepted",
        );
        const responsePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.response");

        let routedRequestId = "";
        let streamId = "";
        agentSocket.once("rpc:request", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }
          routedRequestId = requestId;
          streamId = `stream-${requestId}`;

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame({
              jsonrpc: "2.0",
              id: requestId,
              result: {
                stream_id: streamId,
              },
            }),
          );
        });

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            id: "client-cap-window-1",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
            },
          }),
        });

        const [accepted] = await Promise.all([acceptedPromise, responsePromise]);
        expect(accepted.success).toBe(true);
        expect(accepted.requestId).toBeDefined();

        const pullResponsePromise = waitForEvent<{
          success: boolean;
          requestId?: string;
          streamId?: string;
          windowSize?: number;
        }>(consumerSocket, "relay:rpc.stream.pull_response");
        const agentPullPayloadPromise = waitForEvent<unknown>(agentSocket, "rpc:stream.pull");

        consumerSocket.emit("relay:rpc.stream.pull", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            request_id: accepted.requestId,
            window_size: 25,
          }),
        });

        const [pullResponse, rawAgentPull] = await Promise.all([
          pullResponsePromise,
          agentPullPayloadPromise,
        ]);
        expect(pullResponse.success).toBe(true);
        expect(pullResponse.requestId).toBe(accepted.requestId);
        expect(pullResponse.streamId).toBe(streamId);
        expect(pullResponse.windowSize).toBe(2);

        const decodedAgentPull = decodePayloadFrame(rawAgentPull);
        expect(decodedAgentPull.ok).toBe(true);
        const agentPullPayload =
          decodedAgentPull.ok && isRecord(decodedAgentPull.value.data)
            ? decodedAgentPull.value.data
            : null;
        expect(agentPullPayload).not.toBeNull();
        expect(toRequestId(agentPullPayload?.request_id)).toBe(routedRequestId);
        expect(agentPullPayload?.window_size).toBe(2);
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should abort relay stream explicitly when backpressure buffer overflows", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
          },
        });

        const startedPromise = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerSocket,
          "relay:conversation.started",
        );
        consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);

        const acceptedPromise = waitForEvent<{ success: boolean; requestId?: string }>(
          consumerSocket,
          "relay:rpc.accepted",
        );
        const responsePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.response");
        const completePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.complete", 8_000);

        agentSocket.once("rpc:request", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }
          const streamId = `stream-overflow-${requestId}`;

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame({
              jsonrpc: "2.0",
              id: requestId,
              result: { stream_id: streamId },
            }),
          );

          for (let index = 0; index <= env.socketRelayMaxBufferedChunksPerRequest; index += 1) {
            agentSocket.emit(
              "rpc:chunk",
              encodePayloadFrame({
                stream_id: streamId,
                request_id: requestId,
                chunk_index: index,
                rows: [{ id: index }],
              }),
            );
          }
        });

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            id: "client-backpressure-abort-1",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
            },
          }),
        });

        const [accepted] = await Promise.all([acceptedPromise, responsePromise]);
        expect(accepted.success).toBe(true);

        const rawComplete = await completePromise;
        const decodedComplete = decodePayloadFrame(rawComplete);
        expect(decodedComplete.ok).toBe(true);
        const completePayload =
          decodedComplete.ok && isRecord(decodedComplete.value.data)
            ? decodedComplete.value.data
            : null;
        expect(completePayload).not.toBeNull();
        expect(toRequestId(completePayload?.request_id)).toBe(accepted.requestId);
        expect(completePayload?.terminal_status).toBe("aborted");
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should fail fast relay stream when agent sends invalid rpc:chunk frame", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
          },
        });

        const startedPromise = waitForEvent<{ success: boolean; conversationId: string }>(
          consumerSocket,
          "relay:conversation.started",
        );
        consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        const started = await startedPromise;
        expect(started.success).toBe(true);

        const acceptedPromise = waitForEvent<{ success: boolean; requestId?: string }>(
          consumerSocket,
          "relay:rpc.accepted",
        );
        const responsePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.response");
        const completePromise = waitForEvent<unknown>(consumerSocket, "relay:rpc.complete", 8_000);

        agentSocket.once("rpc:request", (rawPayload: unknown) => {
          const decoded = decodePayloadFrame(rawPayload);
          if (!decoded.ok || !isRecord(decoded.value.data)) {
            return;
          }

          const requestId = toRequestId(decoded.value.data.id);
          if (!requestId) {
            return;
          }
          const streamId = `stream-invalid-${requestId}`;

          agentSocket.emit(
            "rpc:response",
            encodePayloadFrame({
              jsonrpc: "2.0",
              id: requestId,
              result: { stream_id: streamId },
            }),
          );

          agentSocket.emit("rpc:chunk", {
            schemaVersion: "1.0",
            enc: "json",
            cmp: "none",
            contentType: "application/json",
            originalSize: 1,
            compressedSize: 1,
            payload: Buffer.from("{"),
            requestId,
          });
        });

        consumerSocket.emit("relay:rpc.request", {
          conversationId: started.conversationId,
          frame: encodePayloadFrame({
            jsonrpc: "2.0",
            id: "client-invalid-stream-frame-1",
            method: "sql.execute",
            params: {
              sql: "SELECT 1",
            },
          }),
        });

        const [accepted] = await Promise.all([acceptedPromise, responsePromise]);
        expect(accepted.success).toBe(true);

        const rawComplete = await completePromise;
        const decodedComplete = decodePayloadFrame(rawComplete);
        expect(decodedComplete.ok).toBe(true);
        const completePayload =
          decodedComplete.ok && isRecord(decodedComplete.value.data)
            ? decodedComplete.value.data
            : null;
        expect(completePayload).not.toBeNull();
        expect(toRequestId(completePayload?.request_id)).toBe(accepted.requestId);
        expect(completePayload?.terminal_status).toBe("error");
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });

    it("should enforce relay conversation start rate limit per consumer", async () => {
      const consumerSocket = await connectConsumer(baseUrl, accessToken);
      const agentSocket = await connectAgent(baseUrl, agentAccessToken);

      try {
        await registerAgentAndWaitReady(agentSocket, {
          protocols: ["jsonrpc-v2"],
          encodings: ["json"],
          compressions: ["none"],
          extensions: {
            streamingResults: true,
          },
        });

        const rateLimitedPromise = new Promise<{
          success: false;
          error: { code?: string; statusCode?: number };
        }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            consumerSocket.off("relay:conversation.started", onStarted);
            reject(new Error("Timed out waiting for relay conversation rate limit"));
          }, 8_000);

          const onStarted = (payload: {
            success: boolean;
            error?: { code?: string; statusCode?: number };
          }): void => {
            if (payload.success === false && payload.error?.code === "RATE_LIMITED") {
              clearTimeout(timeout);
              consumerSocket.off("relay:conversation.started", onStarted);
              resolve(payload as { success: false; error: { code?: string; statusCode?: number } });
            }
          };

          consumerSocket.on("relay:conversation.started", onStarted);
        });

        const attempts = env.socketRelayRateLimitMaxConversationStarts + 3;
        for (let i = 0; i < attempts; i += 1) {
          consumerSocket.emit("relay:conversation.start", { agentId: testAgentId });
        }

        const rejected = await rateLimitedPromise;
        expect(rejected.error.code).toBe("RATE_LIMITED");
        expect(rejected.error.statusCode).toBe(429);
      } finally {
        agentSocket.disconnect();
        consumerSocket.disconnect();
      }
    });
  });

  describe("/agents namespace", () => {
    it("should create catalog row, sync profile and lastLoginUserId on first agent connect", async () => {
      const freshAgentId = randomUUID();
      const freshAgentLoginRes = await request(baseUrl).post("/api/v1/auth/agent-login").send({
        email: "socket@test.com",
        password: "SocketTest1",
        agentId: freshAgentId,
      });
      expect(freshAgentLoginRes.status).toBe(200);

      const agentSocket = await connectAgent(baseUrl, freshAgentLoginRes.body.accessToken as string);
      try {
        const syncHandled = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out waiting for profile sync RPC")), 6_000);
          agentSocket.on("rpc:request", (rawPayload: unknown) => {
            const decoded = decodePayloadFrame(rawPayload);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(timeout);
              reject(new Error("Invalid sync rpc:request payload"));
              return;
            }
            if (decoded.value.data.method !== "agent.getProfile") {
              return;
            }

            const rpcId = toRequestId(decoded.value.data.id);
            if (!rpcId) {
              clearTimeout(timeout);
              reject(new Error("Expected JSON-RPC id on agent.getProfile"));
              return;
            }

            agentSocket.emit(
              "rpc:response",
              encodePayloadFrame({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  agent_id: freshAgentId,
                  profile: {
                    name: "Socket Synced Agent",
                    trade_name: "Socket Store",
                    document: "11222333000181",
                    document_type: "cnpj",
                    mobile: "11999999999",
                    email: "socket-sync@plug.local",
                    address: {
                      street: "Rua Socket",
                      number: "10",
                      district: "Centro",
                      postal_code: "01001000",
                      city: "Sao Paulo",
                      state: "SP",
                    },
                    notes: "profile synced",
                  },
                  updated_at: new Date().toISOString(),
                },
              }),
            );

            clearTimeout(timeout);
            resolve();
          });
        });

        await registerAgentAndWaitReady(
          agentSocket,
          {
            protocols: ["jsonrpc-v2"],
            encodings: ["json"],
            compressions: ["none"],
          },
          freshAgentId,
        );
        await syncHandled;
        await new Promise((resolve) => setTimeout(resolve, 200));

        const catalogRes = await request(baseUrl)
          .get(`/api/v1/agents/catalog/${freshAgentId}`)
          .set("Authorization", `Bearer ${accessToken}`);
        expect(catalogRes.status).toBe(200);
        expect(catalogRes.body.agent.agentId).toBe(freshAgentId);
        expect(catalogRes.body.agent.tradeName).toBe("Socket Store");
        expect(catalogRes.body.agent.document).toBe("11222333000181");
        expect(catalogRes.body.agent.lastLoginUserId).toBeDefined();
      } finally {
        agentSocket.disconnect();
      }
    });

    it("should defer profile sync until agent:ready when protocolReadyAck is explicit", async () => {
      const explicitReadyAgentId = randomUUID();
      const explicitReadyLoginRes = await request(baseUrl).post("/api/v1/auth/agent-login").send({
        email: "socket@test.com",
        password: "SocketTest1",
        agentId: explicitReadyAgentId,
      });
      expect(explicitReadyLoginRes.status).toBe(200);

      const agentSocket = await connectAgent(
        baseUrl,
        explicitReadyLoginRes.body.accessToken as string,
      );
      try {
        let profileRequestBeforeReady = false;
        let readySent = false;
        const profileSyncHandled = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for deferred profile sync RPC")),
            8_000,
          );
          agentSocket.on("rpc:request", (rawPayload: unknown) => {
            const decoded = decodePayloadFrame(rawPayload);
            if (!decoded.ok || !isRecord(decoded.value.data)) {
              clearTimeout(timeout);
              reject(new Error("Invalid deferred sync rpc:request payload"));
              return;
            }
            if (decoded.value.data.method !== "agent.getProfile") {
              return;
            }
            if (!readySent) {
              profileRequestBeforeReady = true;
            }

            const rpcId = toRequestId(decoded.value.data.id);
            if (!rpcId) {
              clearTimeout(timeout);
              reject(new Error("Expected JSON-RPC id on deferred agent.getProfile"));
              return;
            }

            agentSocket.emit(
              "rpc:response",
              encodePayloadFrame({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  agent_id: explicitReadyAgentId,
                  profile: {
                    name: "Deferred Sync Agent",
                  },
                  updated_at: new Date().toISOString(),
                },
              }),
            );
            clearTimeout(timeout);
            resolve();
          });
        });

        const capabilitiesPromise = waitForEvent<unknown>(agentSocket, "agent:capabilities");
        agentSocket.emit(
          "agent:register",
          encodePayloadFrame({
            agentId: explicitReadyAgentId,
            capabilities: {
              protocols: ["jsonrpc-v2"],
              encodings: ["json"],
              compressions: ["none"],
              extensions: {
                protocolReadyAck: true,
              },
            },
            timestamp: new Date().toISOString(),
          }),
        );
        await capabilitiesPromise;
        await new Promise((resolve) => setTimeout(resolve, env.socketAgentProtocolReadyGraceMs + 1_500));
        expect(profileRequestBeforeReady).toBe(false);

        readySent = true;
        agentSocket.emit(
          "agent:ready",
          encodePayloadFrame({
            agent_id: explicitReadyAgentId,
            protocol: "jsonrpc-v2",
            timestamp: new Date().toISOString(),
          }),
        );
        await profileSyncHandled;
      } finally {
        agentSocket.disconnect();
      }
    });

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
