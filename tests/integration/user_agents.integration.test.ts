import { randomUUID } from "node:crypto";

import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { env } from "../../src/shared/config/env";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { createTestServer } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser, seedAgent } from "./helpers/seed_agent";

const app = createApp();

const waitForSocketEvent = <T>(
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

const connectAgentSocket = (baseUrl: string, agentAccessToken: string): Promise<ReturnType<typeof ioClient>> =>
  new Promise<ReturnType<typeof ioClient>>((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agents`, {
      auth: { token: agentAccessToken },
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

    socket.on("connect_error", (error) => reject(error));
  });

const registerAgentOnHub = async (
  socket: ReturnType<typeof ioClient>,
  agentId: string,
): Promise<void> => {
  const capabilitiesPromise = waitForSocketEvent<unknown>(socket, "agent:capabilities");
  socket.emit(
    "agent:register",
    encodePayloadFrame({
      agentId,
      capabilities: {
        protocols: ["jsonrpc-v2"],
        encodings: ["json"],
        compressions: ["none"],
      },
    }),
  );
  await capabilitiesPromise;
  if (env.socketAgentProtocolReadyGraceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.socketAgentProtocolReadyGraceMs));
  }
};

describe("User agents API", () => {
  let adminToken = "";
  let regularToken = "";
  let regularUserId = "";

  beforeAll(async () => {
    const admin = await seedAdminUser(app, {
      email: `ua-admin-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    adminToken = admin.accessToken;

    const email = `ua-user-${Date.now()}@test.com`;
    const password = "User1234";
    const reg = await request(app).post("/api/v1/auth/register").send({ email, password });
    await approveRegistrationByToken(app, reg.body.approvalToken as string);
    regularUserId = reg.body.user.id as string;

    const login = await request(app).post("/api/v1/auth/login").send({ email, password });
    regularToken = login.body.accessToken as string;
  });

  it("GET /api/v1/me/agents returns empty list for a new user", async () => {
    const res = await request(app)
      .get("/api/v1/me/agents")
      .set("Authorization", `Bearer ${regularToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("GET /api/v1/users/:userId/agents allows admins to inspect a user's managed agents", async () => {
    const res = await request(app)
      .get(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.agents)).toBe(true);
  });

  it("GET /api/v1/users/:userId/agents rejects non-admin users", async () => {
    const res = await request(app)
      .get(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${regularToken}`);

    expect(res.status).toBe(403);
  });

  it("legacy ownership mutation endpoints are no longer exposed", async () => {
    const targetAgentId = randomUUID();
    const requests = [
      request(app)
        .post("/api/v1/me/agents")
        .set("Authorization", `Bearer ${regularToken}`)
        .send({ agentIds: [targetAgentId] }),
      request(app)
        .delete("/api/v1/me/agents")
        .set("Authorization", `Bearer ${regularToken}`)
        .send({ agentIds: [targetAgentId] }),
      request(app)
        .post(`/api/v1/users/${regularUserId}/agents`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ agentIds: [targetAgentId] }),
      request(app)
        .delete(`/api/v1/users/${regularUserId}/agents`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ agentIds: [targetAgentId] }),
      request(app)
        .put(`/api/v1/users/${regularUserId}/agents`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ agentIds: [targetAgentId] }),
    ];

    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });
});

describe("Automatic agent ownership binding", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl = "";
  let userAccessToken = "";
  let agentAccessToken = "";
  let adminToken = "";
  let userId = "";
  let agentId = "";
  let agentSocket: ReturnType<typeof ioClient> | null = null;

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();

    const admin = await seedAdminUser(baseUrl, {
      email: `auto-bind-admin-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    adminToken = admin.accessToken;

    const email = `auto-bind-user-${Date.now()}@test.com`;
    const password = "User1234";
    const reg = await request(baseUrl).post("/api/v1/auth/register").send({ email, password });
    expect(reg.status).toBe(201);
    await approveRegistrationByToken(baseUrl, reg.body.approvalToken as string);
    userId = reg.body.user.id as string;

    const login = await request(baseUrl).post("/api/v1/auth/login").send({ email, password });
    expect(login.status).toBe(200);
    userAccessToken = login.body.accessToken as string;

    agentId = randomUUID();
    await seedAgent({
      agentId,
      name: "Auto Bind Agent",
      cnpjCpf: `auto-bind-${agentId.slice(0, 8)}`,
    });

    const agentLogin = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });
    expect(agentLogin.status).toBe(200);
    agentAccessToken = agentLogin.body.accessToken as string;
  });

  afterAll(async () => {
    agentSocket?.disconnect();
    await server.close();
  });

  it("binds the agent to the user when agent:register completes", async () => {
    agentSocket = await connectAgentSocket(baseUrl, agentAccessToken);
    await registerAgentOnHub(agentSocket, agentId);

    const meList = await request(baseUrl)
      .get("/api/v1/me/agents")
      .set("Authorization", `Bearer ${userAccessToken}`);
    expect(meList.status).toBe(200);
    expect(meList.body.agents.some((agent: { agentId: string }) => agent.agentId === agentId)).toBe(
      true,
    );

    const adminList = await request(baseUrl)
      .get(`/api/v1/users/${userId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(
      adminList.body.agents.some((agent: { agentId: string }) => agent.agentId === agentId),
    ).toBe(true);
  });
});
