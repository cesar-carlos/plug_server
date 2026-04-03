import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();
const repositories = getTestRepositoryAccess();

const registerAndApprove = async (email: string, password: string): Promise<string> => {
  const reg = await request(app).post("/api/v1/auth/register").send({ email, password });
  expect(reg.status).toBe(201);
  await approveRegistrationByToken(app, reg.body.approvalToken as string);
  return reg.body.user.id as string;
};

describe("Agent login ownership", () => {
  it("agent-login succeeds for an active unbound catalog agent", async () => {
    const agentId = randomUUID();
    const email = `access-ok-${Date.now()}@test.com`;
    const password = "Ownership1";

    await registerAndApprove(email, password);
    await seedAgent({ agentId, name: "Test Agent", cnpjCpf: "52998224725" });

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });

    expect(login.status).toBe(200);
    expect(login.body.user.agentId).toBe(agentId);
  });

  it("agent-login alone does not create ownership before agent:register", async () => {
    const agentId = randomUUID();
    const email = `login-only-${Date.now()}@test.com`;
    const password = "Ownership1";

    await registerAndApprove(email, password);
    await seedAgent({ agentId, name: "Login Only Agent", cnpjCpf: "52998224724" });

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });

    expect(login.status).toBe(200);
    await expect(repositories.agentIdentity.findOwnerUserId(agentId)).resolves.toBeNull();

    const userLogin = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(userLogin.status).toBe(200);

    const meAgents = await request(app)
      .get("/api/v1/me/agents")
      .set("Authorization", `Bearer ${userLogin.body.accessToken as string}`);
    expect(meAgents.status).toBe(200);
    expect(meAgents.body.agents).toEqual([]);
  });

  it("agent-login succeeds when the agent is already bound to the same user", async () => {
    const agentId = randomUUID();
    const email = `same-owner-${Date.now()}@test.com`;
    const password = "Ownership1";

    const userId = await registerAndApprove(email, password);
    await seedAgent({ agentId, name: "Bound Agent", cnpjCpf: "11222333000181" });
    await seedAgentBinding(userId, agentId);

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });

    expect(login.status).toBe(200);
    expect(login.body.user.agentId).toBe(agentId);
  });

  it("invalidates previous agent session after password change", async () => {
    const agentId = randomUUID();
    const email = `agent-session-${Date.now()}@test.com`;
    const initialPassword = "Ownership1";
    const updatedPassword = "Ownership2";

    await registerAndApprove(email, initialPassword);
    await seedAgent({ agentId, name: "Session Agent", cnpjCpf: "11222333000183" });

    const userLogin = await request(app).post("/api/v1/auth/login").send({
      email,
      password: initialPassword,
    });
    expect(userLogin.status).toBe(200);

    const agentLogin = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password: initialPassword,
      agentId,
    });
    expect(agentLogin.status).toBe(200);

    const changePassword = await request(app)
      .patch("/api/v1/auth/password")
      .set("Authorization", `Bearer ${userLogin.body.accessToken as string}`)
      .send({
        currentPassword: initialPassword,
        newPassword: updatedPassword,
      });
    expect(changePassword.status).toBe(204);

    const oldAgentAccess = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${agentLogin.body.accessToken as string}`);
    expect(oldAgentAccess.status).toBe(401);

    const oldAgentRefresh = await request(app).post("/api/v1/auth/refresh").send({
      refreshToken: agentLogin.body.refreshToken as string,
    });
    expect(oldAgentRefresh.status).toBe(401);

    const newAgentLogin = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password: updatedPassword,
      agentId,
    });
    expect(newAgentLogin.status).toBe(200);
  });

  it("agent-login succeeds when agent is not yet in catalog", async () => {
    const agentId = randomUUID();
    const email = `no-catalog-${Date.now()}@test.com`;
    const password = "Ownership1";

    await registerAndApprove(email, password);

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });

    expect(login.status).toBe(200);
    expect(login.body.user.agentId).toBe(agentId);
  });

  it("agent-login fails when agent is inactive", async () => {
    const agentId = randomUUID();
    const email = `inactive-${Date.now()}@test.com`;
    const password = "Ownership1";

    await registerAndApprove(email, password);
    await seedAgent({
      agentId,
      name: "Inactive Agent",
      cnpjCpf: "11222333000182",
      status: "inactive",
    });

    const login = await request(app).post("/api/v1/auth/agent-login").send({
      email,
      password,
      agentId,
    });

    expect(login.status).toBe(403);
  });

  it("agent-login fails when the agent is already bound to another user", async () => {
    const agentId = randomUUID();
    const emailA = `owner-a-${Date.now()}@test.com`;
    const emailB = `owner-b-${Date.now()}@test.com`;
    const password = "Ownership1";

    const userAId = await registerAndApprove(emailA, password);
    await registerAndApprove(emailB, password);

    await seedAgent({ agentId, name: "Shared Agent", cnpjCpf: "52998224726" });
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

    expect(loginB.status).toBe(409);
    expect(loginB.body.code).toBe("AGENT_ALREADY_LINKED");
  });
});
