import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

const registerAndApprove = async (email: string, password: string): Promise<string> => {
  const reg = await request(app).post("/api/v1/auth/register").send({ email, password });
  expect(reg.status).toBe(201);
  await approveRegistrationByToken(app, reg.body.approvalToken as string);
  return reg.body.user.id as string;
};

describe("Agent login ownership", () => {
  it("agent-login requires a pre-existing catalog entry and binding", async () => {
    const agentId = randomUUID();
    const email = `access-ok-${Date.now()}@test.com`;
    const password = "Ownership1";

    const userId = await registerAndApprove(email, password);
    await seedAgent({ agentId, name: "Test Agent", cnpjCpf: "52998224725" });
    await seedAgentBinding(userId, agentId);

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });
    expect(login.status).toBe(200);
    expect(login.body.user.agentId).toBe(agentId);
  });

  it("agent-login fails when agent is not in catalog", async () => {
    const agentId = randomUUID();
    const email = `no-catalog-${Date.now()}@test.com`;
    const password = "Ownership1";

    await registerAndApprove(email, password);

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });
    expect(login.status).toBe(404);
  });

  it("agent-login fails when agent is inactive", async () => {
    const agentId = randomUUID();
    const email = `inactive-${Date.now()}@test.com`;
    const password = "Ownership1";

    const userId = await registerAndApprove(email, password);
    await seedAgent({
      agentId,
      name: "Inactive Agent",
      cnpjCpf: "11222333000181",
      status: "inactive",
    });
    await seedAgentBinding(userId, agentId);

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });
    expect(login.status).toBe(403);
  });

  it("agent-login fails when user has no binding to agent", async () => {
    const agentId = randomUUID();
    const email = `no-bind-${Date.now()}@test.com`;
    const password = "Ownership1";

    await registerAndApprove(email, password);
    await seedAgent({ agentId, name: "Unbound Agent", cnpjCpf: "52998224725" });

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });
    expect(login.status).toBe(403);
  });

  it("a second user cannot use an agentId already bound to another user", async () => {
    const agentId = randomUUID();
    const emailA = `owner-a-${Date.now()}@test.com`;
    const emailB = `owner-b-${Date.now()}@test.com`;
    const password = "Ownership1";

    const userAId = await registerAndApprove(emailA, password);
    await registerAndApprove(emailB, password);

    await seedAgent({ agentId, name: "Shared Agent", cnpjCpf: "52998224725" });
    await seedAgentBinding(userAId, agentId);

    const loginA = await request(app).post("/api/v1/auth/agent-login").send({
      email: emailA,
      password,
      agentId,
    });
    expect(loginA.status).toBe(200);

    const loginB = await request(app).post("/api/v1/auth/agent-login").send({
      email: emailB,
      password,
      agentId,
    });
    expect(loginB.status).toBe(403);
  });
});
