import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestNoopEmailSender } from "../../src/shared/di/container";
import { registerOwnerSession } from "./helpers/client_sessions";
import { approveClientRegistrationByToken } from "./helpers/approve_client_registration";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();
const emailSender = getTestNoopEmailSender();

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
    const loginClient = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
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

  it("lists rejected client registrations for the owner and preserves the rejected contract", async () => {
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
        email: `rejected-managed-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Rejected",
        lastName: "Managed",
      });
    expect(registerClient.status).toBe(201);

    const rejectRegistration = await request(app)
      .post("/api/v1/client-auth/registration/reject")
      .send({
        token: registerClient.body.approvalToken,
        reason: "Rejected in review",
      });
    expect(rejectRegistration.status).toBe(200);

    const rejectedList = await request(app)
      .get("/api/v1/me/clients")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "rejected" });
    expect(rejectedList.status).toBe(200);
    expect(rejectedList.body.count).toBeGreaterThanOrEqual(1);

    const rejectedClient = (
      rejectedList.body.clients as Array<{ id: string; email: string; status: string }>
    ).find((client) => client.id === registerClient.body.client.id);
    expect(rejectedClient).toMatchObject({
      id: registerClient.body.client.id,
      email: registerClient.body.client.email,
      status: "rejected",
    });

    const detailResponse = await request(app)
      .get(`/api/v1/me/clients/${registerClient.body.client.id as string}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.client.status).toBe("rejected");
  });

  it("lists managed clients with db-backed filters, pagination and stable order", async () => {
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients-page" });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;
    const suffix = Date.now();

    for (const [name, status] of [
      ["Alpha", "active"],
      ["Beta", "blocked"],
      ["Gamma", "active"],
    ] as const) {
      const registerClient = await request(app)
        .post("/api/v1/client-auth/register")
        .send({
          ownerEmail,
          email: `${name.toLowerCase()}-page-${suffix}@test.com`,
          password: "ClientPwd1",
          name,
          lastName: "Paged",
        });
      expect(registerClient.status).toBe(201);
      await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);
      if (status === "blocked") {
        const blockResponse = await request(app)
          .patch(`/api/v1/me/clients/${registerClient.body.client.id as string}/status`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .send({ status: "blocked" });
        expect(blockResponse.status).toBe(200);
      }
    }

    const blockedOnly = await request(app)
      .get("/api/v1/me/clients")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "blocked", search: "beta", page: 1, pageSize: 1 });
    expect(blockedOnly.status).toBe(200);
    expect(blockedOnly.body.count).toBe(1);
    expect(blockedOnly.body.total).toBe(1);
    expect(blockedOnly.body.page).toBe(1);
    expect(blockedOnly.body.pageSize).toBe(1);
    expect(blockedOnly.body.clients[0]?.name).toBe("Beta");

    const pageOne = await request(app)
      .get("/api/v1/me/clients")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ page: 1, pageSize: 1 });
    const pageTwo = await request(app)
      .get("/api/v1/me/clients")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ page: 2, pageSize: 1 });
    expect(pageOne.status).toBe(200);
    expect(pageTwo.status).toBe(200);
    expect(pageOne.body.clients[0]?.id).not.toBe(pageTwo.body.clients[0]?.id);
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
    const clientLogin = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
        email: registerClient.body.client.email as string,
        password: "ClientPwd1",
      });
    expect(clientLogin.status).toBe(200);
    const clientAccessToken = clientLogin.body.accessToken as string;

    const agent = await seedAgent({
      name: "Owner Managed Agent",
      cnpjCpf: `owner-managed-${Date.now()}`,
    });
    await seedAgentBinding(owner.userId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);
    expect(requestAccess.body.requested).toEqual([agent.agentId]);
    const publicToken = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof publicToken).toBe("string");

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

    const statusByPublicToken = await request(app)
      .get("/api/v1/client-access/status")
      .query({ token: publicToken });
    expect(statusByPublicToken.status).toBe(404);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).toContain(agent.agentId);
  });

  it("lets owner reject access requests from managed clients", async () => {
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
        email: `reject-client-${Date.now()}@test.com`,
        password: "ClientPwd1",
        name: "Reject",
        lastName: "Target",
      });
    expect(registerClient.status).toBe(201);
    await approveClientRegistrationByToken(app, registerClient.body.approvalToken as string);
    const clientLogin = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
        email: registerClient.body.client.email as string,
        password: "ClientPwd1",
      });
    expect(clientLogin.status).toBe(200);
    const clientAccessToken = clientLogin.body.accessToken as string;

    const agent = await seedAgent({
      name: "Reject Test Agent",
      cnpjCpf: `reject-agent-${Date.now()}`,
    });
    await seedAgentBinding(owner.userId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);
    expect(requestAccess.body.requested).toEqual([agent.agentId]);
    const publicToken = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof publicToken).toBe("string");

    const ownerRequests = await request(app)
      .get("/api/v1/me/client-access-requests")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "pending", agentId: agent.agentId });
    expect(ownerRequests.status).toBe(200);
    expect(ownerRequests.body.count).toBe(1);
    const requestId = ownerRequests.body.requests[0]?.id as string;
    expect(typeof requestId).toBe("string");

    const reject = await request(app)
      .post(`/api/v1/me/client-access-requests/${requestId}/reject`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ reason: "Not authorised at this time" });
    expect(reject.status).toBe(200);
    expect(reject.body.rejected).toBe(true);
    expect(reject.body.agentId).toBe(agent.agentId);

    // Token is deleted after owner decision — status endpoint returns 404
    const statusByPublicToken = await request(app)
      .get("/api/v1/client-access/status")
      .query({ token: publicToken });
    expect(statusByPublicToken.status).toBe(404);

    // Verify request row is marked as rejected via the owner's list
    const rejectedRequests = await request(app)
      .get("/api/v1/me/client-access-requests")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "rejected", agentId: agent.agentId });
    expect(rejectedRequests.status).toBe(200);
    expect(rejectedRequests.body.requests[0]?.status).toBe("rejected");
    expect(rejectedRequests.body.requests[0]?.decisionReason).toBe("Not authorised at this time");

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).not.toContain(agent.agentId);
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

    const clientLogin = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
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
    const clientLogin = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
        email: registerClient.body.client.email as string,
        password: "ClientPwd1",
      });
    expect(clientLogin.status).toBe(200);
    const clientId = registerClient.body.client.id as string;
    const clientAccessToken = clientLogin.body.accessToken as string;

    const agent = await seedAgent({
      name: "Revocation Agent",
      cnpjCpf: `revoke-agent-${Date.now()}`,
    });
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
      (listAgentClients.body.clients as Array<{ clientId: string }>).some(
        (item) => item.clientId === clientId,
      ),
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

  it("lists owner-managed agent clients with db-backed filters, pagination and stable order", async () => {
    const suffix = `agent-client-page-${Date.now()}`;
    const owner = await registerOwnerSession(app, { emailPrefix: "owner-clients", suffix });
    const ownerProfile = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerProfile.status).toBe(200);
    const ownerEmail = ownerProfile.body.user.email as string;

    const firstClientRegister = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `alpha-${suffix}@test.com`,
        password: "ClientPwd1",
        name: "Alpha",
        lastName: "Viewer",
      });
    expect(firstClientRegister.status).toBe(201);
    await approveClientRegistrationByToken(app, firstClientRegister.body.approvalToken as string);
    const firstClientLogin = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
        email: firstClientRegister.body.client.email as string,
        password: "ClientPwd1",
      });
    expect(firstClientLogin.status).toBe(200);

    const secondClientRegister = await request(app)
      .post("/api/v1/client-auth/register")
      .send({
        ownerEmail,
        email: `beta-${suffix}@test.com`,
        password: "ClientPwd1",
        name: "Beta",
        lastName: "Viewer",
      });
    expect(secondClientRegister.status).toBe(201);
    await approveClientRegistrationByToken(app, secondClientRegister.body.approvalToken as string);
    const secondClientLogin = await request(app)
      .post("/api/v1/client-auth/login")
      .send({
        email: secondClientRegister.body.client.email as string,
        password: "ClientPwd1",
      });
    expect(secondClientLogin.status).toBe(200);

    const agent = await seedAgent({
      name: `Paged Agent ${suffix}`,
      cnpjCpf: `paged-agent-${suffix}`,
    });
    await seedAgentBinding(owner.userId, agent.agentId);

    for (const accessToken of [
      firstClientLogin.body.accessToken as string,
      secondClientLogin.body.accessToken as string,
    ]) {
      const requestAccess = await request(app)
        .post("/api/v1/client/me/agents")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ agentIds: [agent.agentId] });
      expect(requestAccess.status).toBe(200);
    }

    const ownerRequests = await request(app)
      .get("/api/v1/me/client-access-requests")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .query({ status: "pending", agentId: agent.agentId, pageSize: 10 });
    expect(ownerRequests.status).toBe(200);
    const requestIds = (ownerRequests.body.requests as Array<{ id: string }>).map((item) => item.id);
    expect(requestIds).toHaveLength(2);

    for (const requestId of requestIds) {
      const approve = await request(app)
        .post(`/api/v1/me/client-access-requests/${requestId}/approve`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({});
      expect(approve.status).toBe(200);
    }

    const blockedStatus = await request(app)
      .patch(`/api/v1/me/clients/${secondClientRegister.body.client.id as string}/status`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ status: "blocked" });
    expect(blockedStatus.status).toBe(200);

    const blockedOnly = await request(app)
      .get(`/api/v1/me/agents/${agent.agentId}/clients`)
      .query({ status: "blocked", search: "beta", page: 1, pageSize: 1 })
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(blockedOnly.status).toBe(200);
    expect(blockedOnly.body.total).toBe(1);
    expect(blockedOnly.body.count).toBe(1);
    expect(blockedOnly.body.page).toBe(1);
    expect(blockedOnly.body.pageSize).toBe(1);
    expect(blockedOnly.body.clients[0]).toMatchObject({
      clientId: secondClientRegister.body.client.id,
      email: secondClientRegister.body.client.email,
      name: "Beta",
      status: "blocked",
    });

    const firstPage = await request(app)
      .get(`/api/v1/me/agents/${agent.agentId}/clients`)
      .query({ page: 1, pageSize: 1 })
      .set("Authorization", `Bearer ${owner.accessToken}`);
    const secondPage = await request(app)
      .get(`/api/v1/me/agents/${agent.agentId}/clients`)
      .query({ page: 2, pageSize: 1 })
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(firstPage.status).toBe(200);
    expect(secondPage.status).toBe(200);
    expect(firstPage.body.total).toBe(2);
    expect(secondPage.body.total).toBe(2);
    expect(firstPage.body.clients[0]?.clientId).not.toBe(secondPage.body.clients[0]?.clientId);
  });
});
