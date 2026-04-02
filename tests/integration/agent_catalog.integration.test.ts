import { randomUUID } from "node:crypto";

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser, seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

describe("Agent catalog API", () => {
  let adminToken = "";

  beforeAll(async () => {
    const admin = await seedAdminUser(app, {
      email: `catalog-admin-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    adminToken = admin.accessToken;
  });

  const validAgentId = (): string => randomUUID();

  it("legacy manual catalog create/update endpoints are removed", async () => {
    const agent = await seedAgent({ name: "Legacy Agent", cnpjCpf: "legacy-manual-1" });

    const postRes = await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentId: validAgentId(), name: "Manual Create" });
    expect(postRes.status).toBe(404);

    const patchRes = await request(app)
      .patch(`/api/v1/agents/catalog/${agent.agentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Manual Update" });
    expect(patchRes.status).toBe(404);
  });

  it("GET /api/v1/agents/catalog — lists agents", async () => {
    const agent = await seedAgent({ name: "Listed Agent", cnpjCpf: "listed-unique-1" });

    const res = await request(app)
      .get("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.agents)).toBe(true);
    const ids = (res.body.agents as Array<{ agentId: string }>).map((a) => a.agentId);
    expect(ids).toContain(agent.agentId);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.count);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
  });

  it("GET /api/v1/agents/catalog — supports pagination", async () => {
    await seedAgent({ name: "Pagination Agent 1", cnpjCpf: "pagination-unique-1" });
    await seedAgent({ name: "Pagination Agent 2", cnpjCpf: "pagination-unique-2" });

    const res = await request(app)
      .get("/api/v1/agents/catalog")
      .query({ page: 1, pageSize: 1 })
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(1);
  });

  it("GET /api/v1/agents/catalog/:agentId — returns single agent", async () => {
    const agent = await seedAgent({ name: "Single Agent", cnpjCpf: "single-unique-1" });

    const res = await request(app)
      .get(`/api/v1/agents/catalog/${agent.agentId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agent.agentId).toBe(agent.agentId);
  });

  it("GET /api/v1/agents/catalog/:agentId — 404 for missing agent", async () => {
    const res = await request(app)
      .get(`/api/v1/agents/catalog/${randomUUID()}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("DELETE /api/v1/agents/catalog/:agentId — deactivates agent", async () => {
    const agent = await seedAgent({ name: "To Deactivate", cnpjCpf: "deactivate-unique-1" });

    const res = await request(app)
      .delete(`/api/v1/agents/catalog/${agent.agentId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agent.status).toBe("inactive");
  });

  it("DELETE catalog returns 403 for non-admin user", async () => {
    const email = `cat-user-${Date.now()}@test.com`;
    const password = "User1234";

    const regRes = await request(app).post("/api/v1/auth/register").send({ email, password });
    await approveRegistrationByToken(app, regRes.body.approvalToken as string);
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password });
    const userToken = loginRes.body.accessToken as string;

    const res = await request(app)
      .delete(`/api/v1/agents/catalog/${validAgentId()}`)
      .set("Authorization", `Bearer ${userToken}`)
      .send();
    expect(res.status).toBe(403);
  });

  it("GET catalog — non-admin sees only linked agents and 403 on unlinked id", async () => {
    const email = `cat-read-${Date.now()}@test.com`;
    const password = "User1234";
    const regRes = await request(app).post("/api/v1/auth/register").send({ email, password });
    expect(regRes.status).toBe(201);
    await approveRegistrationByToken(app, regRes.body.approvalToken as string);
    const userId = regRes.body.user.id as string;
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);
    const userToken = loginRes.body.accessToken as string;

    const linked = await seedAgent({ name: "Linked Only", cnpjCpf: `linked-${Date.now()}` });
    const unlinked = await seedAgent({ name: "Unlinked", cnpjCpf: `unlinked-${Date.now()}` });
    await seedAgentBinding(userId, linked.agentId);

    const listRes = await request(app)
      .get("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${userToken}`);
    expect(listRes.status).toBe(200);
    const ids = (listRes.body.agents as Array<{ agentId: string }>).map((a) => a.agentId);
    expect(ids).toContain(linked.agentId);
    expect(ids).not.toContain(unlinked.agentId);
    expect(listRes.body.total).toBe(ids.length);

    const forbiddenRes = await request(app)
      .get(`/api/v1/agents/catalog/${unlinked.agentId}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(forbiddenRes.status).toBe(403);

    const okRes = await request(app)
      .get(`/api/v1/agents/catalog/${linked.agentId}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.agent.agentId).toBe(linked.agentId);
  });

  it("GET catalog/:id — non-admin can read inactive agent when linked", async () => {
    const email = `cat-inactive-${Date.now()}@test.com`;
    const password = "User1234";
    const regRes = await request(app).post("/api/v1/auth/register").send({ email, password });
    expect(regRes.status).toBe(201);
    await approveRegistrationByToken(app, regRes.body.approvalToken as string);
    const userId = regRes.body.user.id as string;
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);
    const userToken = loginRes.body.accessToken as string;

    const inactive = await seedAgent({
      name: "Inactive Linked",
      cnpjCpf: `inactive-${Date.now()}`,
      status: "inactive",
    });
    await seedAgentBinding(userId, inactive.agentId);

    const res = await request(app)
      .get(`/api/v1/agents/catalog/${inactive.agentId}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agent.status).toBe("inactive");
  });
});
