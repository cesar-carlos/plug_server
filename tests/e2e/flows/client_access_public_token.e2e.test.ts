import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getTestNoopEmailSender, getTestRepositoryAccess } from "../../../src/shared/di/container";
import { registerHubClient } from "../helpers/auth_tokens";
import { startE2EHubFixture, type E2EHubFixture } from "../helpers/e2e_hub_fixture";
import { connectPlugAgenteSocket, registerAgentOnHub } from "../helpers/plug_agente_socket";

describe("E2E client-access public approval token", () => {
  let ctx!: E2EHubFixture;
  const repositories = getTestRepositoryAccess();

  beforeAll(async () => {
    ctx = await startE2EHubFixture();
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.close();
    }
  });

  it("GET review then POST approve via token matches integration behaviour", async () => {
    const agentSocket = await connectPlugAgenteSocket(ctx.baseUrl, ctx.agentAccessToken);
    try {
      await registerAgentOnHub(agentSocket, ctx.agentId);

      const client = await registerHubClient(
        ctx.baseUrl,
        ctx.user.email,
        `e2e-access-token-${Date.now()}-${randomUUID().slice(0, 8)}@plug.test`,
        "E2eClient1",
      );

      const emailSender = getTestNoopEmailSender();
      const sentBefore = emailSender.clientAccessRequestsToOwner.length;

      const requestAccess = await request(ctx.baseUrl)
        .post("/api/v1/client/me/agents")
        .set("Authorization", `Bearer ${client.accessToken}`)
        .send({ agentIds: [ctx.agentId] });
      expect(requestAccess.status).toBe(200);

      const captured = emailSender.clientAccessRequestsToOwner[sentBefore];
      expect(captured?.agentId).toBe(ctx.agentId);
      const token = captured?.approvalToken;
      expect(typeof token).toBe("string");

      const reviewResponse = await request(ctx.baseUrl)
        .get("/api/v1/client-access/review")
        .query({ token });
      expect(reviewResponse.status).toBe(200);
      expect(reviewResponse.headers["content-type"]).toMatch(/text\/html/);
      expect(reviewResponse.text).toContain("/assets/approval-focus.js");

      const approveResponse = await request(ctx.baseUrl)
        .post("/api/v1/client-access/approve")
        .type("form")
        .set("Accept", "text/html,application/xhtml+xml")
        .send({ token });
      expect(approveResponse.status).toBe(200);
      expect(approveResponse.headers["content-type"]).toContain("text/html");
      expect(approveResponse.text).toContain("Acesso aprovado");
      expect(approveResponse.text).toContain(ctx.agentId);

      const approvedAgents = await request(ctx.baseUrl)
        .get("/api/v1/client/me/agents")
        .set("Authorization", `Bearer ${client.accessToken}`);
      expect(approvedAgents.status).toBe(200);
      expect(approvedAgents.body.agentIds).toContain(ctx.agentId);

      const storedToken = await repositories.clientAgentAccessApprovalToken.findById(token!);
      expect(storedToken).toBeNull();

      const storedAccess = await repositories.clientAgentAccess.hasAccess(
        client.clientId,
        ctx.agentId,
      );
      expect(storedAccess).toBe(true);
    } finally {
      agentSocket.disconnect();
    }
  });
});
