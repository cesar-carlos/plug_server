import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { seedAgent } from "./helpers/seed_agent";
const app = createApp();
describe("PWA authenticated contracts", () => {
  it("rejects anonymous requests", async () => {
    expect(
      (
        await request(app)
          .post("/api/v1/client/me/pwa/offline-authorization")
          .send({ agentIds: [] })
      ).status,
    ).toBe(401);
    expect((await request(app).get("/api/v1/client/me/pwa/push-key")).status).toBe(401);
  });
  it("issues only the current client's grant and rejects revoked access", async () => {
    const session = await registerOwnerAndClientSession(app);
    const agent = await seedAgent({ name: "PWA fixture", cnpjCpf: `pwa-${Date.now()}` });
    const repositories = getTestRepositoryAccess();
    await repositories.clientAgentAccess.addAccess(session.client.clientId, agent.agentId);
    const send = (): request.Test =>
      request(app)
        .post("/api/v1/client/me/pwa/offline-authorization")
        .set("Authorization", `Bearer ${session.client.accessToken}`)
        .send({ agentIds: [agent.agentId] });
    const result = await send();
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.data.userId).toBe(session.client.clientId);
    expect(result.body.data.agentIds).toEqual([agent.agentId]);
    expect(Date.parse(result.body.data.expiresAt) - Date.parse(result.body.data.issuedAt)).toBe(
      86400000,
    );
    await repositories.clientAgentAccess.removeAccess(session.client.clientId, agent.agentId);
    expect((await send()).status).toBe(403);
  });
  it("rejects caller-provided identity in a strict request", async () => {
    const session = await registerOwnerAndClientSession(app);
    const response = await request(app)
      .post("/api/v1/client/me/pwa/offline-authorization")
      .set("Authorization", `Bearer ${session.client.accessToken}`)
      .send({ agentIds: [], userId: "other" });
    expect(response.status).toBe(400);
  });
});
