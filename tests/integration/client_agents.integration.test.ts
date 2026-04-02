import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { approveClientRegistrationByToken } from "./helpers/approve_client_registration";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();
const repositories = getTestRepositoryAccess();

const registerOwnerAndClient = async (): Promise<{
  ownerUserId: string;
  clientId: string;
  clientAccessToken: string;
}> => {
  const unique = Date.now().toString() + Math.random().toString(16).slice(2, 8);
  const ownerEmail = `client-owner-${unique}@test.com`;
  const ownerPassword = "Owner1234";

  const ownerRegister = await request(app)
    .post("/api/v1/auth/register")
    .send({ email: ownerEmail, password: ownerPassword });
  expect(ownerRegister.status).toBe(201);
  await approveRegistrationByToken(app, ownerRegister.body.approvalToken as string);
  const ownerUserId = ownerRegister.body.user.id as string;
  const ownerLogin = await request(app).post("/api/v1/auth/login").send({
    email: ownerEmail,
    password: ownerPassword,
  });
  expect(ownerLogin.status).toBe(200);
  const ownerAccessToken = ownerLogin.body.accessToken as string;

  const clientRegister = await request(app)
    .post("/api/v1/client-auth/register")
    .send({
      ownerEmail,
      email: `client-${unique}@test.com`,
      password: "Client1234",
      name: "Client",
      lastName: "Viewer",
    });
  expect(clientRegister.status).toBe(201);
  await approveClientRegistrationByToken(app, clientRegister.body.approvalToken as string);
  const clientLogin = await request(app).post("/api/v1/client-auth/login").send({
    email: `client-${unique}@test.com`,
    password: "Client1234",
  });
  expect(clientLogin.status).toBe(200);

  return {
    ownerUserId,
    clientId: clientRegister.body.client.id as string,
    clientAccessToken: clientLogin.body.accessToken as string,
  };
};

describe("Client agent access API", () => {
  it("POST /api/v1/client/me/agents requests access by agentId", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Approval Target", cnpjCpf: `client-request-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const response = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });

    expect(response.status).toBe(200);
    expect(response.body.requested).toEqual([agent.agentId]);
    expect(response.body.alreadyApproved).toEqual([]);
  });

  it("GET /api/v1/client/me/agents lists approved agent profiles", async () => {
    const { clientId, clientAccessToken } = await registerOwnerAndClient();
    const approved = await seedAgent({
      name: "Approved Agent",
      tradeName: "Approved Trade",
      cnpjCpf: `client-approved-${Date.now()}`,
      email: "approved@test.com",
      notes: "approved profile",
    });
    const inactive = await seedAgent({
      name: "Inactive Approved Agent",
      cnpjCpf: `client-inactive-${Date.now()}`,
      status: "inactive",
    });
    const unapproved = await seedAgent({ name: "Unapproved Agent", cnpjCpf: `client-unapproved-${Date.now()}` });

    await repositories.clientAgentAccess.addAccess(clientId, approved.agentId);
    await repositories.clientAgentAccess.addAccess(clientId, inactive.agentId);

    const response = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect(response.body.agentIds).toEqual([approved.agentId, inactive.agentId]);

    const ids = (response.body.agents as Array<{ agentId: string }>).map((agent) => agent.agentId);
    expect(ids).toContain(approved.agentId);
    expect(ids).toContain(inactive.agentId);
    expect(ids).not.toContain(unapproved.agentId);

    const approvedDto = (response.body.agents as Array<{ agentId: string; tradeName: string | null; email: string | null }>).find(
      (agent) => agent.agentId === approved.agentId,
    );
    expect(approvedDto?.tradeName).toBe("Approved Trade");
    expect(approvedDto?.email).toBe("approved@test.com");
    expect(response.body.total).toBe(2);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(20);
  });

  it("GET /api/v1/client/me/agents supports search, status and pagination", async () => {
    const { clientId, clientAccessToken } = await registerOwnerAndClient();
    const alpha = await seedAgent({ name: "Alpha Market", cnpjCpf: `client-alpha-${Date.now()}` });
    const beta = await seedAgent({ name: "Beta Office", cnpjCpf: `client-beta-${Date.now()}` });
    const inactive = await seedAgent({
      name: "Alpha Inactive",
      cnpjCpf: `client-alpha-inactive-${Date.now()}`,
      status: "inactive",
    });

    await repositories.clientAgentAccess.addAccess(clientId, alpha.agentId);
    await repositories.clientAgentAccess.addAccess(clientId, beta.agentId);
    await repositories.clientAgentAccess.addAccess(clientId, inactive.agentId);

    const searchResponse = await request(app)
      .get("/api/v1/client/me/agents")
      .query({ search: "Alpha", status: "active" })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.count).toBe(1);
    expect(searchResponse.body.total).toBe(1);
    expect(searchResponse.body.agents[0]?.agentId).toBe(alpha.agentId);

    const pagedResponse = await request(app)
      .get("/api/v1/client/me/agents")
      .query({ page: 1, pageSize: 1 })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(pagedResponse.status).toBe(200);
    expect(pagedResponse.body.count).toBe(1);
    expect(pagedResponse.body.total).toBe(3);
    expect(pagedResponse.body.page).toBe(1);
    expect(pagedResponse.body.pageSize).toBe(1);
  });

  it("GET /api/v1/client/me/agents/:agentId returns only approved agent profiles", async () => {
    const { clientId, clientAccessToken } = await registerOwnerAndClient();
    const approved = await seedAgent({
      name: "Approved Single Agent",
      tradeName: "Single Trade",
      cnpjCpf: `client-single-${Date.now()}`,
      status: "inactive",
    });
    const unapproved = await seedAgent({ name: "Forbidden Agent", cnpjCpf: `client-forbidden-${Date.now()}` });

    await repositories.clientAgentAccess.addAccess(clientId, approved.agentId);

    const okResponse = await request(app)
      .get(`/api/v1/client/me/agents/${approved.agentId}`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(okResponse.status).toBe(200);
    expect(okResponse.body.agent.agentId).toBe(approved.agentId);
    expect(okResponse.body.agent.tradeName).toBe("Single Trade");
    expect(okResponse.body.agent.status).toBe("inactive");

    const forbiddenResponse = await request(app)
      .get(`/api/v1/client/me/agents/${unapproved.agentId}`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(forbiddenResponse.status).toBe(403);
    expect(forbiddenResponse.body.code).toBe("AGENT_ACCESS_DENIED");

    const missingResponse = await request(app)
      .get(`/api/v1/client/me/agents/${randomUUID()}`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(missingResponse.status).toBe(403);
  });

  it("GET /api/v1/client/me/agent-access-requests supports status, search and pagination", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const alpha = await seedAgent({ name: "Alpha Request Agent", cnpjCpf: `request-alpha-${Date.now()}` });
    const beta = await seedAgent({ name: "Beta Request Agent", cnpjCpf: `request-beta-${Date.now()}` });
    const gamma = await seedAgent({ name: "Gamma Request Agent", cnpjCpf: `request-gamma-${Date.now()}` });
    await seedAgentBinding(ownerUserId, alpha.agentId);
    await seedAgentBinding(ownerUserId, beta.agentId);
    await seedAgentBinding(ownerUserId, gamma.agentId);

    const requestAlpha = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [alpha.agentId] });
    expect(requestAlpha.status).toBe(200);

    const requestBeta = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [beta.agentId] });
    expect(requestBeta.status).toBe(200);

    const requestGamma = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [gamma.agentId] });
    expect(requestGamma.status).toBe(200);

    const pendingResponse = await request(app)
      .get("/api/v1/client/me/agent-access-requests")
      .query({ status: "pending", search: "Alpha" })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(pendingResponse.status).toBe(200);
    expect(pendingResponse.body.count).toBe(1);
    expect(pendingResponse.body.total).toBe(1);
    expect(pendingResponse.body.requests[0]?.agentId).toBe(alpha.agentId);
    expect(pendingResponse.body.requests[0]?.agentName).toBe("Alpha Request Agent");

    const pagedResponse = await request(app)
      .get("/api/v1/client/me/agent-access-requests")
      .query({ page: 1, pageSize: 2 })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(pagedResponse.status).toBe(200);
    expect(pagedResponse.body.count).toBe(2);
    expect(pagedResponse.body.total).toBe(3);
    expect(pagedResponse.body.page).toBe(1);
    expect(pagedResponse.body.pageSize).toBe(2);
  });
});
