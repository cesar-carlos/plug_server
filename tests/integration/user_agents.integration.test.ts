import { randomUUID } from "node:crypto";

import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { env } from "../../src/shared/config/env";
import { decodePayloadFrame, encodePayloadFrame } from "../../src/shared/utils/payload_frame";
import { createTestServer } from "../helpers/test_server";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser, seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

describe("User agents API", () => {
  let adminToken = "";
  let regularToken = "";
  let regularUserId = "";
  let secondUserId = "";

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

    const secondReg = await request(app)
      .post("/api/v1/auth/register")
      .send({
        email: `ua-user-2-${Date.now()}@test.com`,
        password,
      });
    await approveRegistrationByToken(app, secondReg.body.approvalToken as string);
    secondUserId = secondReg.body.user.id as string;
  });

  it("GET /api/v1/me/agents — returns empty list for new user", async () => {
    const res = await request(app)
      .get("/api/v1/me/agents")
      .set("Authorization", `Bearer ${regularToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("POST /api/v1/users/:userId/agents — admin adds agents to user", async () => {
    const agent = await seedAgent({ name: "Agent Add Test", cnpjCpf: "52998224725" });

    const res = await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(res.status).toBe(200);
  });

  it("GET /api/v1/me/agents — lists agents after binding", async () => {
    const agent = await seedAgent({ name: "My Agent", cnpjCpf: "11222333000181" });

    await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });

    const res = await request(app)
      .get("/api/v1/me/agents")
      .set("Authorization", `Bearer ${regularToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agents.some((a: { agentId: string }) => a.agentId === agent.agentId)).toBe(
      true,
    );
  });

  it("POST /api/v1/users/:userId/agents — fails for unknown agentId", async () => {
    const res = await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [randomUUID()] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("AGENT_NOT_FOUND");
  });

  it("POST /api/v1/users/:userId/agents — fails when agent is already linked to another user", async () => {
    const agent = await seedAgent({ name: "Already Linked", cnpjCpf: "52998224733" });

    const first = await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/users/${secondUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("AGENT_ALREADY_LINKED");
  });

  it("DELETE /api/v1/users/:userId/agents — admin removes agents", async () => {
    const agent = await seedAgent({ name: "To Remove", cnpjCpf: "52998224729" });

    await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });

    const del = await request(app)
      .delete(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(del.status).toBe(200);
  });

  it("PUT /api/v1/users/:userId/agents — replaces entire agent list", async () => {
    const a1 = await seedAgent({ name: "Replace A1", cnpjCpf: "52998224730" });
    const a2 = await seedAgent({ name: "Replace A2", cnpjCpf: "52998224731" });

    await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [a1.agentId] });

    const res = await request(app)
      .put(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [a2.agentId] });
    expect(res.status).toBe(200);

    const list = await request(app)
      .get(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${adminToken}`);
    const ids = list.body.agents.map((a: { agentId: string }) => a.agentId);
    expect(ids).toContain(a2.agentId);
    expect(ids).not.toContain(a1.agentId);
  });

  it("POST /api/v1/users/:userId/agents — non-admin gets 403", async () => {
    const agent = await seedAgent({ name: "Forbidden Agent", cnpjCpf: "52998224732" });

    const res = await request(app)
      .post(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${regularToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(res.status).toBe(403);
  });

  it("GET /api/v1/users/:userId/agents — non-admin gets 403", async () => {
    const res = await request(app)
      .get(`/api/v1/users/${regularUserId}/agents`)
      .set("Authorization", `Bearer ${regularToken}`);
    expect(res.status).toBe(403);
  });
});

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
    socket.on("connect_error", (err) => reject(err));
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

describe("Self-service /me/agents (online presence)", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let baseUrl: string;
  let adminToken = "";
  let user1Token = "";
  let user1Id = "";

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = server.getUrl();

    const admin = await seedAdminUser(baseUrl, {
      email: `ua-self-admin-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    adminToken = admin.accessToken;

    const email1 = `ua-self-1-${Date.now()}@test.com`;
    const password = "User1234";
    const reg1 = await request(baseUrl).post("/api/v1/auth/register").send({ email: email1, password });
    await approveRegistrationByToken(baseUrl, reg1.body.approvalToken as string);
    user1Id = reg1.body.user.id as string;
    const login1 = await request(baseUrl).post("/api/v1/auth/login").send({ email: email1, password });
    user1Token = login1.body.accessToken as string;
  });

  afterAll(async () => {
    await server.close();
  });

  it("POST /api/v1/me/agents — 422 when agent exists but is not online for this user", async () => {
    const agent = await seedAgent({ name: "Offline Self", cnpjCpf: "52998224740" });

    const res = await request(baseUrl)
      .post("/api/v1/me/agents")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ agentIds: [agent.agentId] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("AGENT_NOT_ONLINE_FOR_USER");
    expect(res.body.details?.reason).toBe("offline");
  });

  it("POST /api/v1/me/agents — 403 when agent is inactive in catalog", async () => {
    const agent = await seedAgent({
      name: "Inactive Self",
      cnpjCpf: "52998224744",
      status: "inactive",
    });

    const res = await request(baseUrl)
      .post("/api/v1/me/agents")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ agentIds: [agent.agentId] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AGENT_INACTIVE");
  });

  it("POST /api/v1/me/agents — 422 when another user has the agent online", async () => {
    const agent = await seedAgent({ name: "Other Online", cnpjCpf: "52998224741" });
    const repos = getTestRepositoryAccess();
    const regU2 = await request(baseUrl)
      .post("/api/v1/auth/register")
      .send({ email: `ua-self-o-${Date.now()}@test.com`, password: "User1234" });
    await approveRegistrationByToken(baseUrl, regU2.body.approvalToken as string);
    const ownerId = regU2.body.user.id as string;
    await seedAgentBinding(ownerId, agent.agentId);

    const agentLoginRes = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: regU2.body.user.email as string,
      password: "User1234",
      agentId: agent.agentId,
    });
    expect(agentLoginRes.status).toBe(200);
    const socket = await connectAgentSocket(baseUrl, agentLoginRes.body.accessToken as string);
    try {
      await registerAgentOnHub(socket, agent.agentId);

      const res = await request(baseUrl)
        .post("/api/v1/me/agents")
        .set("Authorization", `Bearer ${user1Token}`)
        .send({ agentIds: [agent.agentId] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("AGENT_NOT_ONLINE_FOR_USER");
      expect(res.body.details?.reason).toBe("different_account");
    } finally {
      socket.disconnect();
      await repos.agentIdentity.removeAgentIds(ownerId, [agent.agentId]);
    }
  });

  it("POST /api/v1/me/agents — 409 when agent is already linked to another user", async () => {
    const agent = await seedAgent({ name: "Conflict Self", cnpjCpf: "52998224745" });
    const repos = getTestRepositoryAccess();

    const emailA = `ua-self-409a-${Date.now()}@test.com`;
    const emailB = `ua-self-409b-${Date.now()}@test.com`;
    const password = "User1234";

    const regA = await request(baseUrl).post("/api/v1/auth/register").send({ email: emailA, password });
    await approveRegistrationByToken(baseUrl, regA.body.approvalToken as string);
    const uidA = regA.body.user.id as string;

    const regB = await request(baseUrl).post("/api/v1/auth/register").send({ email: emailB, password });
    await approveRegistrationByToken(baseUrl, regB.body.approvalToken as string);
    const uidB = regB.body.user.id as string;

    await request(baseUrl)
      .post(`/api/v1/users/${uidA}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });

    const al = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email: emailA,
      password,
      agentId: agent.agentId,
    });
    expect(al.status).toBe(200);
    const socket = await connectAgentSocket(baseUrl, al.body.accessToken as string);
    try {
      await registerAgentOnHub(socket, agent.agentId);

      await repos.agentIdentity.removeAgentIds(uidA, [agent.agentId]);
      const bindB = await repos.agentIdentity.addAgentIds(uidB, [agent.agentId]);
      if (bindB.kind !== "ok") {
        throw new Error(`Expected bind uidB: ${bindB.kind}`);
      }

      const loginA = await request(baseUrl).post("/api/v1/auth/login").send({ email: emailA, password });
      const tokA = loginA.body.accessToken as string;

      const res = await request(baseUrl)
        .post("/api/v1/me/agents")
        .set("Authorization", `Bearer ${tokA}`)
        .send({ agentIds: [agent.agentId] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("AGENT_ALREADY_LINKED");
    } finally {
      socket.disconnect();
      await repos.agentIdentity.removeAgentIds(uidB, [agent.agentId]);
    }
  });

  it("POST /api/v1/me/agents — re-links when agent is online after admin removed binding", async () => {
    const agent = await seedAgent({ name: "Self Relink", cnpjCpf: "52998224742" });
    const email = `ua-self-relink-${Date.now()}@test.com`;
    const password = "User1234";
    const reg = await request(baseUrl).post("/api/v1/auth/register").send({ email, password });
    await approveRegistrationByToken(baseUrl, reg.body.approvalToken as string);
    const uid = reg.body.user.id as string;

    await request(baseUrl)
      .post(`/api/v1/users/${uid}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });

    const al = await request(baseUrl).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId: agent.agentId,
    });
    expect(al.status).toBe(200);
    const sock = await connectAgentSocket(baseUrl, al.body.accessToken as string);
    try {
      await registerAgentOnHub(sock, agent.agentId);

      await request(baseUrl)
        .delete(`/api/v1/users/${uid}/agents`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ agentIds: [agent.agentId] });

      const login = await request(baseUrl).post("/api/v1/auth/login").send({ email, password });
      const tok = login.body.accessToken as string;

      const add = await request(baseUrl)
        .post("/api/v1/me/agents")
        .set("Authorization", `Bearer ${tok}`)
        .send({ agentIds: [agent.agentId] });
      expect(add.status).toBe(200);

      const list = await request(baseUrl).get("/api/v1/me/agents").set("Authorization", `Bearer ${tok}`);
      expect(list.status).toBe(200);
      expect(list.body.agents.some((a: { agentId: string }) => a.agentId === agent.agentId)).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it("DELETE /api/v1/me/agents — removes own bindings (no online requirement)", async () => {
    const agent = await seedAgent({ name: "Self Delete", cnpjCpf: "52998224743" });
    await request(baseUrl)
      .post(`/api/v1/users/${user1Id}/agents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentIds: [agent.agentId] });

    const del = await request(baseUrl)
      .delete("/api/v1/me/agents")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ agentIds: [agent.agentId] });
    expect(del.status).toBe(200);

    const list = await request(baseUrl).get("/api/v1/me/agents").set("Authorization", `Bearer ${user1Token}`);
    expect(list.body.agents.some((a: { agentId: string }) => a.agentId === agent.agentId)).toBe(false);
  });
});
