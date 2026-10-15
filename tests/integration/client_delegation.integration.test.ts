import request from "supertest";
import { describe, it, expect } from "vitest";
import { createApp } from "../../src/app";
import { registerOwnerAndClientSession } from "./helpers/client_sessions";
import { getTestRepositoryAccess } from "../../src/shared/di/container";
import { Client } from "../../src/domain/entities/client.entity";
import { randomUUID } from "node:crypto";
import { prismaClient } from "../../src/infrastructure/database/prisma/client";
const app = createApp();
describe("Persona Client delegation", () => {
  it("persists explicit scopes and rejects unsupported, duplicate and verification-injected scopes", async () => {
    const { client } = await registerOwnerAndClientSession(app);
    const binding = { audience: "https://mcp.fixture.test", personaId: randomUUID() };
    const administrative = ["treinar", "publicar", "gerenciar_tokens", "gerenciar_integracoes"];
    const created = await request(app)
      .post("/api/v1/client-auth/persona-delegations")
      .set("Authorization", "Bearer " + client.accessToken)
      .send({ ...binding, administrative });
    expect(created.status).toBe(201);
    expect(created.body.data.administrative).toEqual(administrative);
    const verify = (body: object): request.Test =>
      request(app)
        .post("/api/v1/client-auth/persona-delegations/verify")
        .set("Authorization", "Bearer " + created.body.data.credential)
        .send(body);
    expect((await verify(binding)).body.data.administrative).toEqual(administrative);
    expect((await verify({ ...binding, administrative: ["gerenciar_fontes"] })).status).toBe(400);
    for (const invalid of [[], ["aprovar_operacao"], ["treinar", "treinar"]]) {
      expect(
        (
          await request(app)
            .post("/api/v1/client-auth/persona-delegations")
            .set("Authorization", "Bearer " + client.accessToken)
            .send({ ...binding, administrative: invalid })
        ).status,
      ).toBe(400);
    }
  });

  it("binds an opaque credential to active Client, audience/persona and first revocation", async () => {
    const { client, owner } = await registerOwnerAndClientSession(app);
    const binding = { audience: "https://mcp.fixture.test", personaId: randomUUID() };
    const denied = await request(app)
      .post("/api/v1/client-auth/persona-delegations")
      .set("Authorization", "Bearer " + owner.accessToken)
      .send(binding);
    expect(denied.status).toBe(403);
    const created = await request(app)
      .post("/api/v1/client-auth/persona-delegations")
      .set("Authorization", "Bearer " + client.accessToken)
      .send(binding);
    expect(created.status).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const value = created.body.data;
    expect(value.credential).toMatch(/^pdv2_[A-Za-z0-9_-]{43}$/);
    expect(value.clientId).toBe(client.clientId);
    const verify = (body = binding): request.Test =>
      request(app)
        .post("/api/v1/client-auth/persona-delegations/verify")
        .set("Authorization", "Bearer " + value.credential)
        .send(body);
    expect((await verify()).body.data.active).toBe(true);
    expect((await verify({ ...binding, personaId: randomUUID() })).status).toBe(401);
    expect((await verify({ ...binding, audience: "https://other.fixture.test" })).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/v1/client-auth/me")
          .set("Authorization", "Bearer " + value.credential)
      ).status,
    ).toBe(401);
    const other = await registerOwnerAndClientSession(app);
    expect(
      (
        await request(app)
          .delete("/api/v1/client-auth/persona-delegations/" + value.id)
          .set("Authorization", "Bearer " + other.client.accessToken)
      ).status,
    ).toBe(404);
    expect((await verify()).status).toBe(200);
    expect(
      (
        await request(app)
          .delete("/api/v1/client-auth/persona-delegations/" + value.id)
          .set("Authorization", "Bearer " + client.accessToken)
      ).status,
    ).toBe(204);
    expect((await verify()).status).toBe(401);
    // Revocation remains idempotent and metadata audit does not repeat or store secrets.
    expect(
      (
        await request(app)
          .delete("/api/v1/client-auth/persona-delegations/" + value.id)
          .set("Authorization", "Bearer " + client.accessToken)
      ).status,
    ).toBe(204);
    if (process.env.CONTAINER_PERSISTENCE_MODE === "prisma") {
      const events = await prismaClient.auditEvent.findMany({
        where: { eventType: { startsWith: "client.persona_delegation." } },
      });
      const own = events.filter((e) => JSON.stringify(e.payloadJson).includes(value.id));
      expect(own.map((e) => e.eventType).sort()).toEqual([
        "client.persona_delegation.created",
        "client.persona_delegation.revoked",
      ]);
      expect(own.every((e) => e.actorRole === "client" && e.actorUserId === null)).toBe(true);
      expect(JSON.stringify(own)).not.toContain(value.credential);
      expect(JSON.stringify(own)).not.toContain("tokenHash");
      expect(JSON.stringify(own)).not.toContain("token_hash");
    }
  });
  it("refuses invalid audience, credentials and credential epoch changes", async () => {
    const { client } = await registerOwnerAndClientSession(app);
    const binding = { audience: "https://mcp.fixture.test", personaId: randomUUID() };
    for (const audience of [
      "http://mcp.fixture.test",
      "https://mcp.fixture.test/path",
      "https://user@host.test",
      "https://mcp.fixture.test/",
    ])
      expect(
        (
          await request(app)
            .post("/api/v1/client-auth/persona-delegations")
            .set("Authorization", "Bearer " + client.accessToken)
            .send({ ...binding, audience })
        ).status,
      ).toBe(400);
    const created = await request(app)
      .post("/api/v1/client-auth/persona-delegations")
      .set("Authorization", "Bearer " + client.accessToken)
      .send(binding);
    const token = created.body.data.credential;
    const repository = getTestRepositoryAccess().client;
    const entity = await repository.findById(client.clientId);
    await repository.save(
      new Client({ ...entity!, credentialsUpdatedAt: new Date(Date.now() + 1000) }),
    );
    expect(
      (
        await request(app)
          .post("/api/v1/client-auth/persona-delegations/verify")
          .set("Authorization", "Bearer " + token)
          .send(binding)
      ).status,
    ).toBe(401);
    const invalid = await request(app)
      .post("/api/v1/client-auth/persona-delegations/verify")
      .set("Authorization", "Bearer not-a-credential")
      .send(binding);
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain("not-a-credential");
  });
});
