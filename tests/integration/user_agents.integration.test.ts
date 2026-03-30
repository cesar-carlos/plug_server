import { randomUUID } from "node:crypto";

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser, seedAgent } from "./helpers/seed_agent";

const app = createApp();

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
