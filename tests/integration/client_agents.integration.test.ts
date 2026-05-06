import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { ClientAgentAccessRequest } from "../../src/domain/entities/client_agent_access_request.entity";
import { env } from "../../src/shared/config/env";
import { container, getTestNoopEmailSender, getTestRepositoryAccess } from "../../src/shared/di/container";
import { getClientAgentAccessPublicDecisionMetricsSnapshot } from "../../src/shared/metrics/client_agent_access_public_decision.metrics";
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
    const agent = await seedAgent({
      name: "Approval Target",
      cnpjCpf: `client-request-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const response = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });

    expect(response.status).toBe(200);
    expect(response.body.requested).toEqual([agent.agentId]);
    expect(response.body.alreadyApproved).toEqual([]);
    expect(response.body.newRequests).toEqual([agent.agentId]);
    expect(response.body.reopened).toEqual([]);
    expect(response.body.debounced).toEqual([]);
  });

  it("POST /api/v1/client/me/agents reports alreadyApproved when access already exists", async () => {
    const { clientId, ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Already Approved Agent",
      cnpjCpf: `client-already-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);
    await repositories.clientAgentAccess.addAccess(clientId, agent.agentId);

    const response = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });

    expect(response.status).toBe(200);
    expect(response.body.requested).toEqual([]);
    expect(response.body.alreadyApproved).toEqual([agent.agentId]);
    expect(response.body.newRequests).toEqual([]);
    expect(response.body.reopened).toEqual([]);
    expect(response.body.debounced).toEqual([]);
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

  it("returns 400 when agent access request retry path param is not a UUID", async () => {
    const { clientAccessToken } = await registerOwnerAndClient();

    const response = await request(app)
      .post("/api/v1/client/me/agent-access-requests/not-a-uuid/retry")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
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
    const unapproved = await seedAgent({
      name: "Unapproved Agent",
      cnpjCpf: `client-unapproved-${Date.now()}`,
    });

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

    const approvedDto = (
      response.body.agents as Array<{
        agentId: string;
        tradeName: string | null;
        email: string | null;
      }>
    ).find((agent) => agent.agentId === approved.agentId);
    expect(approvedDto?.tradeName).toBe("Approved Trade");
    expect(approvedDto?.email).toBe("approved@test.com");
    for (const agent of response.body.agents as Array<{ isHubConnected: boolean }>) {
      expect(agent.isHubConnected).toBe(false);
    }
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
    const unapproved = await seedAgent({
      name: "Forbidden Agent",
      cnpjCpf: `client-forbidden-${Date.now()}`,
    });

    await repositories.clientAgentAccess.addAccess(clientId, approved.agentId);

    const okResponse = await request(app)
      .get(`/api/v1/client/me/agents/${approved.agentId}`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(okResponse.status).toBe(200);
    expect(okResponse.body.agent.agentId).toBe(approved.agentId);
    expect(okResponse.body.agent.tradeName).toBe("Single Trade");
    expect(okResponse.body.agent.status).toBe("inactive");
    expect(okResponse.body.agent.isHubConnected).toBe(false);

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
    const alpha = await seedAgent({
      name: "Alpha Request Agent",
      cnpjCpf: `request-alpha-${Date.now()}`,
    });
    const beta = await seedAgent({
      name: "Beta Request Agent",
      cnpjCpf: `request-beta-${Date.now()}`,
    });
    const gamma = await seedAgent({
      name: "Gamma Request Agent",
      cnpjCpf: `request-gamma-${Date.now()}`,
    });
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
    const agent = await seedAgent({
      name: "Token Review Agent",
      cnpjCpf: `token-review-${Date.now()}`,
    });
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

    const reviewResponse = await request(app).get("/api/v1/client-access/review").query({ token });
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers["content-type"]).toContain("text/html");
    expect(reviewResponse.text).toContain("Revisar acesso do cliente");
    expect(reviewResponse.text).toContain(String(token));
    expect(reviewResponse.text).toContain(email?.clientEmail ?? "");
    expect(reviewResponse.text).toContain(agent.name);

    const statusResponse = await request(app).get("/api/v1/client-access/status").query({ token });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({ status: "pending" });
  });

  it("GET /api/v1/client-access/review without a stored token does not show decision forms", async () => {
    const missingToken = "a".repeat(64);
    const reviewResponse = await request(app)
      .get("/api/v1/client-access/review")
      .query({ token: missingToken });
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers["content-type"]).toContain("text/html");
    expect(reviewResponse.text).toContain("Este link é inválido");
    expect(reviewResponse.text).not.toContain("method=\"post\"");
  });

  it("POST /api/v1/client-access/approve with form body returns friendly HTML for expired token", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Form Html Expire Agent",
      cnpjCpf: `form-html-expire-${Date.now()}`,
    });
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

    const approveResponse = await request(app)
      .post("/api/v1/client-access/approve")
      .type("form")
      .set("Accept", "text/html,application/xhtml+xml")
      .send({ token: token! });
    expect(approveResponse.status).toBe(410);
    expect(approveResponse.headers["content-type"]).toContain("text/html");
    expect(approveResponse.text).toContain("Este link de aprovação expirou");
  });

  it("POST /api/v1/client-access/approve grants access via public token flow", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Approve Agent",
      cnpjCpf: `token-approve-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");
    const beforeMetrics = {
      startedTotal: getClientAgentAccessPublicDecisionMetricsSnapshot().approve.startedTotal,
      approvedTotal: getClientAgentAccessPublicDecisionMetricsSnapshot().approve.outcomes.approved,
    };

    const approveResponse = await request(app)
      .post("/api/v1/client-access/approve")
      .type("form")
      .set("Accept", "text/html,application/xhtml+xml")
      .set("X-Request-Id", "req-client-access-form-approve")
      .send({ token });
    expect(approveResponse.status).toBe(200);
    expect(approveResponse.headers["content-type"]).toContain("text/html");
    expect(approveResponse.text).toContain("Acesso aprovado");
    expect(approveResponse.text).toContain(agent.agentId);
    const afterMetrics = getClientAgentAccessPublicDecisionMetricsSnapshot();
    expect(afterMetrics.approve.startedTotal).toBe(beforeMetrics.startedTotal + 1);
    expect(afterMetrics.approve.outcomes.approved).toBe(beforeMetrics.approvedTotal + 1);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).toContain(agent.agentId);
  });

  it("POST /api/v1/client-access/approve returns friendly HTML with request id when the approval transaction fails", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Approve Failure Agent",
      cnpjCpf: `token-approve-failure-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");
    const beforeMetrics = {
      startedTotal: getClientAgentAccessPublicDecisionMetricsSnapshot().approve.startedTotal,
      serviceUnavailableTotal:
        getClientAgentAccessPublicDecisionMetricsSnapshot().approve.outcomes.service_unavailable,
    };

    const service = container.clientAgentAccessService as unknown as {
      approvalTxn: {
        approvePendingAndGrantAccess: (input: unknown) => Promise<boolean>;
      };
    };
    const original = service.approvalTxn.approvePendingAndGrantAccess;
    service.approvalTxn.approvePendingAndGrantAccess = async () => {
      throw new Error("forced approval transaction failure");
    };

    try {
      const approveResponse = await request(app)
        .post("/api/v1/client-access/approve")
        .type("form")
        .set("Accept", "text/html,application/xhtml+xml")
        .set("X-Request-Id", "req-client-access-503")
        .send({ token });

      expect(approveResponse.status).toBe(503);
      expect(approveResponse.headers["content-type"]).toContain("text/html");
      expect(approveResponse.text).toContain("req-client-access-503");
      expect(approveResponse.text).toContain("temporariamente indispon");
      const afterMetrics = getClientAgentAccessPublicDecisionMetricsSnapshot();
      expect(afterMetrics.approve.startedTotal).toBe(beforeMetrics.startedTotal + 1);
      expect(afterMetrics.approve.outcomes.service_unavailable).toBe(
        beforeMetrics.serviceUnavailableTotal + 1,
      );
    } finally {
      service.approvalTxn.approvePendingAndGrantAccess = original;
    }
  });

  it("POST /api/v1/client-access/approve rejects clients that are no longer active", async () => {
    const { ownerUserId, clientId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Blocked Client Agent",
      cnpjCpf: `token-blocked-client-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const client = await repositories.client.findById(clientId);
    expect(client).not.toBeNull();
    await repositories.client.save(client!.withStatus("blocked"));

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    const approveResponse = await request(app).post("/api/v1/client-access/approve").send({ token });

    expect(approveResponse.status).toBe(403);
    expect(approveResponse.body.code).toBe("FORBIDDEN");
  });

  it("POST /api/v1/client-access/approve rejects agents that are no longer active", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Inactive Agent",
      cnpjCpf: `token-inactive-agent-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    await repositories.agent.save(agent.deactivate());

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    const approveResponse = await request(app).post("/api/v1/client-access/approve").send({ token });

    expect(approveResponse.status).toBe(409);
    expect(approveResponse.body.code).toBe("CONFLICT");
  });

  it("marks public approval tokens as expired and rejects expired decisions", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Expired Agent",
      cnpjCpf: `token-expired-${Date.now()}`,
    });
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

    const statusResponse = await request(app).get("/api/v1/client-access/status").query({ token });
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
    expect(requestsResponse.body.requests[0]?.decisionReason).toBe("Approval token expired");
  });

  it("POST /api/v1/client-access/reject rejects access via public token flow", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Reject Agent",
      cnpjCpf: `token-reject-${Date.now()}`,
    });
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
    expect(rejectResponse.text).toContain("Acesso recusado");
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

  it("POST /api/v1/client/me/agent-access-requests/:requestId/retry reopens rejected access", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Retry Access Agent",
      cnpjCpf: `retry-access-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);
    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const rejectResponse = await request(app).post("/api/v1/client-access/reject").send({ token });
    expect(rejectResponse.status).toBe(200);

    const rejectedRequests = await request(app)
      .get("/api/v1/client/me/agent-access-requests")
      .query({ status: "rejected", search: agent.agentId })
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(rejectedRequests.status).toBe(200);
    const requestId = rejectedRequests.body.requests[0]?.id as string;
    expect(typeof requestId).toBe("string");

    const retrySentBefore = emailSender.clientAccessRequestsToOwner.length;
    const retry = await request(app)
      .post(`/api/v1/client/me/agent-access-requests/${requestId}/retry`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.requested).toEqual([agent.agentId]);
    expect(retry.body.reopened).toEqual([agent.agentId]);
    expect(emailSender.clientAccessRequestsToOwner.length).toBe(retrySentBefore + 1);

    const retryToken = emailSender.clientAccessRequestsToOwner.at(-1)?.approvalToken;
    expect(typeof retryToken).toBe("string");
    const approve = await request(app).post("/api/v1/client-access/approve").send({
      token: retryToken,
    });
    expect(approve.status).toBe(200);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).toContain(agent.agentId);
  });

  it("POST /api/v1/client/me/agent-access-requests/:requestId/retry debounces pending requests", async () => {
    const previousDebounceMs = env.clientAgentAccessRequestEmailDebounceMs;
    (env as { clientAgentAccessRequestEmailDebounceMs: number }).clientAgentAccessRequestEmailDebounceMs =
      60_000;
    try {
      const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
      const agent = await seedAgent({
        name: "Retry Debounce Agent",
        cnpjCpf: `retry-debounce-${Date.now()}`,
      });
      await seedAgentBinding(ownerUserId, agent.agentId);

      const requestAccess = await request(app)
        .post("/api/v1/client/me/agents")
        .set("Authorization", `Bearer ${clientAccessToken}`)
        .send({ agentIds: [agent.agentId] });
      expect(requestAccess.status).toBe(200);

      const pendingRequests = await request(app)
        .get("/api/v1/client/me/agent-access-requests")
        .query({ status: "pending", search: agent.agentId })
        .set("Authorization", `Bearer ${clientAccessToken}`);
      expect(pendingRequests.status).toBe(200);
      const requestId = pendingRequests.body.requests[0]?.id as string;
      const sentBefore = emailSender.clientAccessRequestsToOwner.length;

      const retry = await request(app)
        .post(`/api/v1/client/me/agent-access-requests/${requestId}/retry`)
        .set("Authorization", `Bearer ${clientAccessToken}`)
        .send({});
      expect(retry.status).toBe(200);
      expect(retry.body.requested).toEqual([]);
      expect(retry.body.debounced).toEqual([agent.agentId]);
      expect(emailSender.clientAccessRequestsToOwner.length).toBe(sentBefore);
    } finally {
      (env as { clientAgentAccessRequestEmailDebounceMs: number }).clientAgentAccessRequestEmailDebounceMs =
        previousDebounceMs;
    }
  });

  it("invalidates public approval tokens after they are used", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Single Use Agent",
      cnpjCpf: `token-single-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const firstApprove = await request(app).post("/api/v1/client-access/approve").send({ token });
    expect(firstApprove.status).toBe(200);

    const secondApprove = await request(app).post("/api/v1/client-access/approve").send({ token });
    expect(secondApprove.status).toBe(404);
    expect(secondApprove.body.code).toBe("NOT_FOUND");

    const statusResponse = await request(app).get("/api/v1/client-access/status").query({ token });
    expect(statusResponse.status).toBe(404);
    expect(statusResponse.body.code).toBe("NOT_FOUND");
  });

  it("concurrent public approvals only grant access once", async () => {
    const { ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Token Concurrent Agent",
      cnpjCpf: `token-concurrent-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const sentBefore = emailSender.clientAccessRequestsToOwner.length;
    const requestAccess = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });
    expect(requestAccess.status).toBe(200);

    const token = emailSender.clientAccessRequestsToOwner[sentBefore]?.approvalToken;
    expect(typeof token).toBe("string");

    const [firstApprove, secondApprove] = await Promise.all([
      request(app).post("/api/v1/client-access/approve").send({ token }),
      request(app).post("/api/v1/client-access/approve").send({ token }),
    ]);

    const statuses = [firstApprove.status, secondApprove.status];
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.some((status) => status === 404 || status === 409)).toBe(true);

    const approvedAgents = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(approvedAgents.status).toBe(200);
    expect(approvedAgents.body.agentIds).toContain(agent.agentId);
  });

  it("DELETE /api/v1/client/me/agents removes approved accesses idempotently", async () => {
    const { clientId, clientAccessToken } = await registerOwnerAndClient();
    const alpha = await seedAgent({
      name: "Delete Alpha",
      cnpjCpf: `client-delete-a-${Date.now()}`,
    });
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

  it("DELETE /api/v1/client/me/agents/:agentId removes access without JSON body", async () => {
    const { clientId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Path Delete Agent",
      cnpjCpf: `client-path-del-${Date.now()}`,
    });
    await repositories.clientAgentAccess.addAccess(clientId, agent.agentId);

    const del = await request(app)
      .delete(`/api/v1/client/me/agents/${agent.agentId}`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(del.status).toBe(200);
    expect(del.body.message).toBe("Client agent accesses removed successfully");

    const list = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.agentIds).not.toContain(agent.agentId);
  });

  it("returns 409 when retry count reaches CLIENT_AGENT_ACCESS_MAX_RETRIES", async () => {
    const { clientId, ownerUserId, clientAccessToken } = await registerOwnerAndClient();
    const agent = await seedAgent({
      name: "Max Retry Agent",
      cnpjCpf: `max-retry-${Date.now()}`,
    });
    await seedAgentBinding(ownerUserId, agent.agentId);

    const maxRetries = env.clientAgentAccessMaxRetries;
    if (maxRetries <= 0) {
      return; // limit disabled; skip
    }

    // Directly seed a request at the limit so we don't have to cycle through N real requests.
    const existing = ClientAgentAccessRequest.create({
      clientId,
      agentId: agent.agentId,
      status: "rejected",
      retryCount: maxRetries,
    });
    await repositories.clientAgentAccessRequest.save(existing);

    const attempt = await request(app)
      .post("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ agentIds: [agent.agentId] });

    expect(attempt.status).toBe(409);
    expect(attempt.body.code).toBe("CONFLICT");
  });
});
