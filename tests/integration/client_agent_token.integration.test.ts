import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { seedAgent } from "./helpers/seed_agent";

const app = createApp();
const repositories = getTestRepositoryAccess();

const setupClientAndApprovedAgent = async (): Promise<{
  clientId: string;
  clientAccessToken: string;
  agentId: string;
}> => {
  const session = await registerOwnerAndClientSession(app);
  const agent = await seedAgent({
    name: "Token Agent",
    cnpjCpf: `client-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  await repositories.clientAgentAccess.addAccess(session.client.clientId, agent.agentId);
  return {
    clientId: session.client.clientId,
    clientAccessToken: session.client.accessToken,
    agentId: agent.agentId,
  };
};

describe("Client agent client_token storage", () => {
  it("returns null when no token has been stored yet", async () => {
    const { clientAccessToken, agentId } = await setupClientAndApprovedAgent();
    const response = await request(app)
      .get(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ agentId, clientToken: null });
  });

  it("stores and reads back a token via PUT", async () => {
    const { clientAccessToken, agentId } = await setupClientAndApprovedAgent();
    const token = "ct-" + "x".repeat(40);

    const putResponse = await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: token });
    expect(putResponse.status).toBe(200);
    expect(putResponse.body).toEqual({ agentId, clientToken: token });

    const getResponse = await request(app)
      .get(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.clientToken).toBe(token);
  });

  it("clears the token when PUT body is null", async () => {
    const { clientAccessToken, agentId } = await setupClientAndApprovedAgent();
    await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: "to-be-cleared" });

    const clearResponse = await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: null });
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body.clientToken).toBeNull();

    const getResponse = await request(app)
      .get(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(getResponse.body.clientToken).toBeNull();
  });

  it("normalizes empty string to null", async () => {
    const { clientAccessToken, agentId } = await setupClientAndApprovedAgent();
    await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: "previous-value" });

    const response = await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: "" });
    expect(response.status).toBe(200);
    expect(response.body.clientToken).toBeNull();
  });

  it("rejects token longer than 512 chars with 400", async () => {
    const { clientAccessToken, agentId } = await setupClientAndApprovedAgent();
    const tooLong = "a".repeat(513);
    const response = await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: tooLong });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("denies access when the client has no approved access to the agent", async () => {
    const session = await registerOwnerAndClientSession(app);
    const orphanAgentId = randomUUID();

    const getResponse = await request(app)
      .get(`/api/v1/client/me/agents/${orphanAgentId}/client-token`)
      .set("Authorization", `Bearer ${session.client.accessToken}`);
    expect(getResponse.status).toBe(403);
    expect(getResponse.body.code).toBe("AGENT_ACCESS_DENIED");

    const putResponse = await request(app)
      .put(`/api/v1/client/me/agents/${orphanAgentId}/client-token`)
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({ clientToken: "ignored" });
    expect(putResponse.status).toBe(403);
    expect(putResponse.body.code).toBe("AGENT_ACCESS_DENIED");
  });

  it("exposes hasClientToken in list and detail without leaking the value", async () => {
    const { clientAccessToken, agentId } = await setupClientAndApprovedAgent();

    const beforeList = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(beforeList.status).toBe(200);
    const beforeAgent = (beforeList.body.agents as Array<Record<string, unknown>>).find(
      (a) => a.agentId === agentId,
    );
    expect(beforeAgent?.hasClientToken).toBe(false);
    expect(beforeAgent).not.toHaveProperty("clientToken");

    await request(app)
      .put(`/api/v1/client/me/agents/${agentId}/client-token`)
      .set("Authorization", `Bearer ${clientAccessToken}`)
      .send({ clientToken: "ct-marker-token-value" });

    const afterList = await request(app)
      .get("/api/v1/client/me/agents")
      .set("Authorization", `Bearer ${clientAccessToken}`);
    const afterAgent = (afterList.body.agents as Array<Record<string, unknown>>).find(
      (a) => a.agentId === agentId,
    );
    expect(afterAgent?.hasClientToken).toBe(true);
    expect(JSON.stringify(afterAgent)).not.toContain("ct-marker-token-value");

    const detail = await request(app)
      .get(`/api/v1/client/me/agents/${agentId}`)
      .set("Authorization", `Bearer ${clientAccessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.hasClientToken).toBe(true);
    expect(detail.body.agent).not.toHaveProperty("clientToken");
    expect(JSON.stringify(detail.body.agent)).not.toContain("ct-marker-token-value");
  });
});
