import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { approveRegistrationByToken } from "./helpers/approve_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

const registerOwner = async (): Promise<{
  userId: string;
  accessToken: string;
}> => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const email = `owner-clients-${unique}@test.com`;
  const password = "OwnerClients1";
  const registerRes = await request(app).post("/api/v1/auth/register").send({ email, password });
  expect(registerRes.status).toBe(201);
  await approveRegistrationByToken(app, registerRes.body.approvalToken as string);
  const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(loginRes.status).toBe(200);
  return {
    userId: registerRes.body.user.id as string,
    accessToken: loginRes.body.accessToken as string,
  };
};

describe("User client governance API", () => {
  it("registers client under authenticated owner and lists owner clients", async () => {
    const owner = await registerOwner();

    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        email: `managed-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Managed",
        lastName: "Client",
      });
    expect(registerClient.status).toBe(201);
    expect(registerClient.body.client.userId).toBe(owner.userId);

    const listClients = await request(app)
      .get("/api/v1/me/clients")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(listClients.status).toBe(200);
    expect(listClients.body.count).toBeGreaterThanOrEqual(1);
    expect(
      (listClients.body.clients as Array<{ id: string }>).some(
        (client) => client.id === registerClient.body.client.id,
      ),
    ).toBe(true);
  });

  it("lets owner review and approve access requests from managed clients", async () => {
    const owner = await registerOwner();
    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        email: `approve-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Approval",
        lastName: "Target",
      });
    expect(registerClient.status).toBe(201);
    const clientAccessToken = registerClient.body.accessToken as string;

    const agent = await seedAgent({ name: "Owner Managed Agent", cnpjCpf: `owner-managed-${Date.now()}` });
    await seedAgentBinding(owner.userId, agent.agentId);

    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);
    expect(requestAccess.body.requested).toEqual([agent.agentId]);

    const ownerRequests = await request(app)
      .get("/api/v1/me/client-access-requests")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "pending", agentId: agent.agentId });
    expect(ownerRequests.status).toBe(200);
    expect(ownerRequests.body.count).toBe(1);
    const requestId = ownerRequests.body.requests[0]?.id as string;
    expect(typeof requestId).toBe("string");

    const approve = await request(app)
      .post(`/api/v1/me/client-access-requests/${requestId}/approve`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.approved).toBe(true);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).toContain(agent.agentId);
  });

  it("allows owner to revoke agent access from a managed client", async () => {
    const owner = await registerOwner();
    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        email: `revoke-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Revoke",
        lastName: "Target",
      });
    expect(registerClient.status).toBe(201);
    const clientId = registerClient.body.client.id as string;
    const clientAccessToken = registerClient.body.accessToken as string;

    const agent = await seedAgent({ name: "Revocation Agent", cnpjCpf: `revoke-agent-${Date.now()}` });
    await seedAgentBinding(owner.userId, agent.agentId);

    await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    const ownerRequests = await request(app)
      .get("/api/v1/me/client-access-requests")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "pending", agentId: agent.agentId });
    const requestId = ownerRequests.body.requests[0]?.id as string;
    await request(app)
      .post(`/api/v1/me/client-access-requests/${requestId}/approve`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({});

    const listAgentClients = await request(app)
      .get(`/api/v1/me/agents/${agent.agentId}/clients`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(listAgentClients.status).toBe(200);
    expect(
      (listAgentClients.body.clients as Array<{ clientId: string }>).some((item) => item.clientId === clientId),
    ).toBe(true);

    const revoke = await request(app)
      .delete(`/api/v1/me/agents/${agent.agentId}/clients/${clientId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(true);

    const approvedAgentsAfterRevoke = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgentsAfterRevoke.status).toBe(200);
    expect(approvedAgentsAfterRevoke.body.agentIds).not.toContain(agent.agentId);
  });
});
