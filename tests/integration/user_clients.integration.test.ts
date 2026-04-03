import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { registerOwnerSession } from "./helpers/client_sessions";
import { approveClientRegistrationByToken } from "./helpers/approve_client_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();

describe("User client governance API", () => {
  it("registers client under authenticated owner and lists owner clients", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;

    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `managed-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Managed",
        lastName: "Client",
      });
    expect(registerClient.status).toBe(201);
    await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);
    const loginClient = await request(app).post("/api/v1/client-auth/login").send({
      email: registerClient.body.client.email as string,
      password: "ClientPwd1",
    });
    expect(loginClient.status).toBe(200);
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

  it("gets a managed client by id and hides clients from other owners", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;

    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `managed-detail-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Managed",
        lastName: "Detail",
      });
    expect(registerClient.status).toBe(201);
    await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);

    const detailResponse = await request(app)
      .get(`/api/v1/me/clients/${registerClient.body.client.id as string}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.client.id).toBe(registerClient.body.client.id);
    expect(detailResponse.body.client.email).toBe(registerClient.body.client.email);

    const otherOwner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const hiddenResponse = await request(app)
      .get(`/api/v1/me/clients/${registerClient.body.client.id as string}`)
      .set("Authorization", `Bearer ${otherOwner.accessToken}`);
    expect(hiddenResponse.status).toBe(404);
  });

  it("does not allow owner status endpoint to process pending registrations", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;

    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `pending-managed-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Pending",
        lastName: "Managed",
      });
    expect(registerClient.status).toBe(201);

    const updateStatus = await request(app)
      .patch(`/api/v1/me/clients/${registerClient.body.client.id as string}/status`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ status: "active" });
    expect(updateStatus.status).toBe(409);
    expect(updateStatus.body.code).toBe("CONFLICT");
  });

  it("lets owner review and approve access requests from managed clients", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;
    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `approve-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Approval",
        lastName: "Target",
      });
    expect(registerClient.status).toBe(201);
    await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);
    const clientLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: registerClient.body.client.email as string,
      password: "ClientPwd1",
    });
    expect(clientLogin.status).toBe(200);
    const clientAccessToken = clientLogin.body.accessToken as string;

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

  it("revokes client refresh tokens when owner blocks a managed client", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;

    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `blocked-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Blocked",
        lastName: "Managed",
      });
    expect(registerClient.status).toBe(201);
    await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);

    const clientLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: registerClient.body.client.email as string,
      password: "ClientPwd1",
    });
    expect(clientLogin.status).toBe(200);
    const refreshToken = clientLogin.body.refreshToken as string;
    expect(typeof refreshToken).toBe("string");

    const blockResponse = await request(app)
      .patch(`/api/v1/me/clients/${registerClient.body.client.id as string}/status`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ status: "blocked" });
    expect(blockResponse.status).toBe(200);
    expect(blockResponse.body.client.status).toBe("blocked");

    const refreshResponse = await request(app)
      .post("/api/v1/client-auth/refresh")
      .send({ refreshToken });
    expect(refreshResponse.status).toBe(401);
  });

  it("allows owner to revoke agent access from a managed client", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;
    const registerClient = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `revoke-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Revoke",
        lastName: "Target",
      });
    expect(registerClient.status).toBe(201);
    await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);
    const clientLogin = await request(app).post("/api/v1/client-auth/login").send({
      email: registerClient.body.client.email as string,
      password: "ClientPwd1",
    });
    expect(clientLogin.status).toBe(200);
    const clientId = registerClient.body.client.id as string;
    const clientAccessToken = clientLogin.body.accessToken as string;

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
