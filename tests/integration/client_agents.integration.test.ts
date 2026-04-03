import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestNoopEmailSender, getTestRepositoryAccess } from "../../src/shared/di/container";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { seedAgent, seedAgentBinding } from "./helpers/seed_agent";

const app = createApp();
const repositories = getTestRepositoryAccess();
const emailSender = getTestNoopEmailSender();

const registerOwnerAndClient = async (): Promise<{
  ownerUserId: string;
  ownerAccessToken: string;
  clientId: string;
  clientAccessToken: string;
}> => {
  const session = await registerOwnerAndClientSession(app);

  return {
    ownerUserId: session.owner.userId,
    ownerAccessToken: session.owner.accessToken,
    clientId: session.client.clientId,
    clientAccessToken: session.client.accessToken,
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

  it("POST /api/v1/client/me/agents reports alreadyApproved when access already exists", async () => {
    const { clientId, ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Already Approved Agent", cnpjCpf: `client-already-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);
    await repositories.clientAgentAccess.addAccess(clientId, agent.agentId);

    const response = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });

    expect(response.status).toBe(200);
    expect(response.body.requested).toEqual([]);
    expect(response.body.alreadyApproved).toEqual([agent.agentId]);
  });

  it("enforces principal isolation between client and user HTTP areas", async () => {
    const { ownerAccessToken, clientAccessToken } = await registerOwnerAndClient();

    const userOnClientRoute = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${ownerAccessToken}`);
    expect(userOnClientRoute.status).toBe(403);
    expect(userOnClientRoute.body.code).toBe("FORBIDDEN");

    const clientOnUserRoute = await request(app)
      .get("/api/v1/me/clients")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(clientOnUserRoute.status).toBe(403);
    expect(clientOnUserRoute.body.code).toBe("FORBIDDEN");
  });

  it("denies client HTTP access immediately after owner blocks the client", async () => {
    const { ownerAccessToken, clientId, clientAccessToken } = await registerOwnerAndClient();

    const beforeBlockMe = await request(app)
      .get("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(beforeBlockMe.status).toBe(200);

    const blockStatusResponse = await request(app)
      .patch(`/api/v1/me/clients/${clientId}/status`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .send({ status: "blocked" });
    expect(blockStatusResponse.status).toBe(200);
    expect(blockStatusResponse.body.client.status).toBe("blocked");

    const meAfterBlock = await request(app)
      .get("/api/v1/client-auth/me")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(meAfterBlock.status).toBe(403);
    expect(meAfterBlock.body.code).toBe("FORBIDDEN");

    const agentsAfterBlock = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(agentsAfterBlock.status).toBe(403);
    expect(agentsAfterBlock.body.code).toBe("FORBIDDEN");
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

  it("GET /api/v1/client-access/review and /status expose the pending approval token flow", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Token Review Agent", cnpjCpf: `token-review-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const email = emailSender.clientAccessRequestsToOwner[sentBefore];
    expect(email?.agentId).toBe(agent.agentId);
    const token = email?.approvalToken;
    expect(typeof token).toBe("string");

    const reviewResponse = await request(app)
      .get("/api/v1/client-access/review")
      .query({ token });
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers["content-type"]).toContain("text/html");
    expect(reviewResponse.text).toContain("Review client access");
    expect(reviewResponse.text).toContain(String(token));

    const statusResponse = await request(app)
      .get("/api/v1/client-access/status")
      .query({ token });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({ status: "pending" });
  });

  it("POST /api/v1/client-access/approve grants access via public token flow", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Token Approve Agent", cnpjCpf: `token-approve-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const approveResponse = await request(app)
      .post("/api/v1/client-access/approve")
      .send({ token });
    expect(approveResponse.status).toBe(200);
    expect(approveResponse.headers["content-type"]).toContain("text/html");
    expect(approveResponse.text).toContain("Client access approved");
    expect(approveResponse.text).toContain(agent.agentId);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).toContain(agent.agentId);
  });

  it("marks public approval tokens as expired and rejects expired decisions", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Token Expired Agent", cnpjCpf: `token-expired-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const storedToken = await repositories.clientAgentAccessApprovalToken.findById(token!);
    expect(storedToken).not.toBeNull();
    await repositories.clientAgentAccessApprovalToken.save({
      ...storedToken!,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const statusResponse = await request(app)
      .get("/api/v1/client-access/status")
      .query({ token });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({ status: "expired" });

    const approveResponse = await request(app)
      .post("/api/v1/client-access/approve")
      .send({ token });
    expect(approveResponse.status).toBe(410);
    expect(approveResponse.body.code).toBe("REGISTRATION_TOKEN_EXPIRED");

    const requestsResponse = await request(app)
      .get("/api/v1/client/me/agent-access-requests")
      .query({ status: "expired", search: agent.agentId })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(requestsResponse.status).toBe(200);
    expect(requestsResponse.body.count).toBe(1);
    expect(requestsResponse.body.requests[0]?.status).toBe("expired");
  });

  it("POST /api/v1/client-access/reject rejects access via public token flow", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Token Reject Agent", cnpjCpf: `token-reject-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const rejectResponse = await request(app)
      .post("/api/v1/client-access/reject")
      .send({ token, reason: "Needs compliance review" });
    expect(rejectResponse.status).toBe(200);
    expect(rejectResponse.headers["content-type"]).toContain("text/html");
    expect(rejectResponse.text).toContain("Client access rejected");
    expect(rejectResponse.text).toContain(agent.agentId);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).not.toContain(agent.agentId);

    const requestsResponse = await request(app)
      .get("/api/v1/client/me/agent-access-requests")
      .query({ status: "rejected", search: agent.agentId })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(requestsResponse.status).toBe(200);
    expect(requestsResponse.body.count).toBe(1);
    expect(requestsResponse.body.requests[0]?.agentId).toBe(agent.agentId);
    expect(requestsResponse.body.requests[0]?.status).toBe("rejected");
    expect(requestsResponse.body.requests[0]?.decisionReason).toBe("Needs compliance review");
  });

  it("invalidates public approval tokens after they are used", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({ name: "Token Single Use Agent", cnpjCpf: `token-single-${Date.now()}` });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const firstApprove = await request(app)
      .post("/api/v1/client-access/approve")
      .send({ token });
    expect(firstApprove.status).toBe(200);

    const secondApprove = await request(app)
      .post("/api/v1/client-access/approve")
      .send({ token });
    expect(secondApprove.status).toBe(404);
    expect(secondApprove.body.code).toBe("NOT_FOUND");

    const statusResponse = await request(app)
      .get("/api/v1/client-access/status")
      .query({ token });
    expect(statusResponse.status).toBe(404);
    expect(statusResponse.body.code).toBe("NOT_FOUND");
  });

  it("DELETE /api/v1/client/me/agents removes approved accesses idempotently", async () => {
    const { clientId, clientAccessToken } = await registerOwnerAndClient();
    const alpha = await seedAgent({ name: "Delete Alpha", cnpjCpf: `client-delete-a-${Date.now()}` });
    const beta = await seedAgent({ name: "Delete Beta", cnpjCpf: `client-delete-b-${Date.now()}` });

    await repositories.clientAgentAccess.addAccess(clientId, alpha.agentId);
    await repositories.clientAgentAccess.addAccess(clientId, beta.agentId);

    const firstDelete = await request(app)
      .delete("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [alpha.agentId, beta.agentId] });
    expect(firstDelete.status).toBe(200);
    expect(firstDelete.body.message).toBe("Client agent accesses removed successfully");

    const afterDelete = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.agentIds).toEqual([]);

    const secondDelete = await request(app)
      .delete("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [alpha.agentId, beta.agentId] });
    expect(secondDelete.status).toBe(200);
    expect(secondDelete.body.message).toBe("Client agent accesses removed successfully");
  });
});
