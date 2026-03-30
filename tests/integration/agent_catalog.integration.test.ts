import { randomUUID } from "node:crypto";

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAdminUser, seedAgent } from "./helpers/seed_agent";

const app = createApp();

// Valid CPF/CNPJ values for test payloads
const VALID_CPF_1 = "529.982.247-25"; // 52998224725
const VALID_CNPJ_1 = "11.222.333/0001-81"; // 11222333000181
const VALID_CNPJ_2 = "12.345.678/0001-95"; // 12345678000195

describe("Agent catalog API", () => {
  let adminToken = "";

  beforeAll(async () => {
    const admin = await seedAdminUser(app, {
      email: `catalog-admin-${Date.now()}@test.com`,
      password: "Admin1234",
    });
    adminToken = admin.accessToken;
  });

  const validAgentId = () => randomUUID();

  it("POST /api/v1/agents/catalog — creates agent", async () => {
    const res = await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        agentId: validAgentId(),
        name: "Agente Fiscal SP",
        cnpjCpf: VALID_CNPJ_1,
        observation: "Agente de teste",
      });
    expect(res.status).toBe(201);
    expect(res.body.agent.cnpjCpf).toBe("11222333000181");
    expect(res.body.agent.status).toBe("active");
  });

  it("POST /api/v1/agents/catalog — rejects duplicate agentId", async () => {
    const agentId = validAgentId();
    await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentId, name: "Agent A", cnpjCpf: VALID_CPF_1 });

    const res = await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentId, name: "Agent B", cnpjCpf: VALID_CNPJ_2 });
    expect(res.status).toBe(409);
  });

  it("POST /api/v1/agents/catalog — rejects duplicate cnpjCpf", async () => {
    const cnpjCpf = "62.823.257/0001-09";
    await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentId: validAgentId(), name: "Agent C", cnpjCpf });

    const res = await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentId: validAgentId(), name: "Agent D", cnpjCpf });
    expect(res.status).toBe(409);
  });

  it("POST /api/v1/agents/catalog — rejects invalid document", async () => {
    const res = await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ agentId: validAgentId(), name: "Bad Doc", cnpjCpf: "00000000000" });
    expect(res.status).toBe(400);
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

  it("PATCH /api/v1/agents/catalog/:agentId — updates name and observation", async () => {
    const agent = await seedAgent({ name: "Original Name", cnpjCpf: "patch-unique-1" });

    const res = await request(app)
      .patch(`/api/v1/agents/catalog/${agent.agentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Updated Name", observation: "New obs" });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe("Updated Name");
    expect(res.body.agent.observation).toBe("New obs");
  });

  it("DELETE /api/v1/agents/catalog/:agentId — deactivates agent", async () => {
    const agent = await seedAgent({ name: "To Deactivate", cnpjCpf: "deactivate-unique-1" });

    const res = await request(app)
      .delete(`/api/v1/agents/catalog/${agent.agentId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agent.status).toBe("inactive");
  });

  it("returns 403 for non-admin user", async () => {
    const email = `cat-user-${Date.now()}@test.com`;
    const password = "User1234";

    const regRes = await request(app).post("/api/v1/auth/register").send({ email, password });
    await approveRegistrationByToken(app, regRes.body.approvalToken as string);
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password });
    const userToken = loginRes.body.accessToken as string;

    const res = await request(app)
      .post("/api/v1/agents/catalog")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ agentId: validAgentId(), name: "Unauthorized", cnpjCpf: VALID_CPF_1 });
    expect(res.status).toBe(403);
  });
});
