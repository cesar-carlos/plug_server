import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Explicit fixture only. Prisma and memory modes share the production routes;
// access requests always require the owner's authenticated approval.
async function main() {
  const path = process.env.PERSONA_CHAIN_MANIFEST;
  const persistence = process.env.CONTAINER_PERSISTENCE_MODE;
  if (!path || process.env.NODE_ENV !== "test" || !["memory", "prisma"].includes(persistence ?? ""))
    throw new Error("Explicit isolated test environment required.");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const root = realpathSync(manifest.root);
  if (
    basename(root) !== manifest.runId ||
    dirname(root) !== realpathSync(tmpdir()) ||
    !/^se7e_persona_[a-f0-9]{12}_test$/.test(manifest.runId)
  )
    throw new Error("Invalid fixture root.");
  const sessionRoot = realpathSync(manifest.sessionRoot);
  if (
    dirname(sessionRoot) !== root ||
    !/^chain-[a-f0-9]{32}$/.test(basename(sessionRoot)) ||
    realpathSync(process.cwd()) !== sessionRoot
  )
    throw new Error("Invalid isolated session root/working directory.");
  if (persistence === "prisma") {
    const db = new URL(manifest.hubDatabaseUrl);
    const control = new URL(manifest.controlDatabaseUrl);
    if (
      db.protocol !== "postgresql:" ||
      db.hostname !== "127.0.0.1" ||
      db.port !== control.port ||
      db.pathname !== "/persona_chain_hub_test" ||
      process.env.DATABASE_URL !== manifest.hubDatabaseUrl
    )
      throw new Error("Separate explicit fixture hub database required.");
  }
  const {
    registerHttpRateLimits,
  } = require("../../src/presentation/http/middlewares/rate_limit.middleware");
  registerHttpRateLimits();
  const { createTestServer } = require("../../tests/helpers/test_server");
  const {
    registerOwnerAndClientSession,
  } = require("../../tests/integration/helpers/client_sessions");
  const { seedAgent, seedAgentBinding } = require("../../tests/integration/helpers/seed_agent");
  const request = require("supertest");
  const bootPath = join(sessionRoot, "hub-boot.json");
  const resumed =
    persistence === "prisma" && existsSync(bootPath)
      ? JSON.parse(readFileSync(bootPath, "utf8"))
      : undefined;
  const server = await createTestServer();
  try {
    if (resumed) {
      const url = new URL(resumed.hubUrl);
      if (url.hostname !== "127.0.0.1" || !url.port) throw new Error("Invalid resume endpoint.");
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error: Error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) => {
        server.httpServer.once("error", reject);
        server.httpServer.listen(Number(url.port), "127.0.0.1", resolve);
      });
      Object.assign(manifest.engines, resumed.engines);
    }
    const session = resumed?.session ?? (await registerOwnerAndClientSession(server.httpServer));
    for (const engine of ["postgres", "mssql", "sybase"]) {
      const agentId = resumed ? manifest.engines[engine].agentId : randomUUID();
      if (!resumed) {
        let document = `9${randomInt(10_000_000, 99_999_999)}`;
        for (const length of [9, 10]) {
          const sum = [...document].reduce(
            (n, digit, index) => n + Number(digit) * (length + 1 - index),
            0,
          );
          const remainder = (sum * 10) % 11;
          document += remainder === 10 ? "0" : String(remainder);
        }
        manifest.engines[engine].profileDocument = document;
        await seedAgent({
          agentId,
          name: `Isolated ${engine}`,
          tradeName: "Isolated fixture",
          document,
          documentType: "cpf",
          mobile: "11988887777",
          email: "fixture@example.com",
          address: {
            street: "Fixture",
            number: "1",
            district: "Fixture",
            postalCode: "01001000",
            city: "Fixture",
            state: "SP",
          },
        });
        await seedAgentBinding(session.owner.userId, agentId);
        const access = await request(server.httpServer)
          .post("/api/v1/client/me/agents")
          .set("Authorization", `Bearer ${session.client.accessToken}`)
          .send({ agentIds: [agentId] });
        if (access.status !== 200 || !access.body.requested.includes(agentId))
          throw new Error("Fixture access request refused.");
        const pending = await request(server.httpServer)
          .get("/api/v1/me/client-access-requests")
          .set("Authorization", `Bearer ${session.owner.accessToken}`)
          .query({ status: "pending", agentId });
        if (pending.status !== 200 || pending.body.requests.length !== 1)
          throw new Error("Fixture owner request lookup refused.");
        const approved = await request(server.httpServer)
          .post(`/api/v1/me/client-access-requests/${pending.body.requests[0].id}/approve`)
          .set("Authorization", `Bearer ${session.owner.accessToken}`)
          .send({});
        if (approved.status !== 200 || approved.body.approved !== true)
          throw new Error("Fixture owner approval refused.");
      }
      manifest.engines[engine].agentId = agentId;
      const login = await request(server.httpServer)
        .post("/api/v1/auth/agent-login")
        .send({ email: session.owner.email, password: session.owner.password, agentId });
      if (login.status !== 200) throw new Error("Fixture agent login refused.");
      manifest.engines[engine].agentAuthToken = login.body.accessToken;
      manifest.engines[engine].agentRefreshToken = login.body.refreshToken;
    }
    const hubUrl = resumed?.hubUrl ?? server.getUrl();
    if (persistence === "prisma" && !resumed)
      writeFileSync(bootPath, JSON.stringify({ session, engines: manifest.engines, hubUrl }));
    writeFileSync(
      join(sessionRoot, "hub-ready.json"),
      JSON.stringify({
        ...manifest,
        hubUrl,
        persistence,
        resumed: Boolean(resumed),
        clientId: session.client.clientId,
        client: { email: session.client.email, password: session.client.password },
      }),
    );
    const deadline = Date.now() + 15 * 60_000;
    while (!existsSync(join(sessionRoot, "hub-stop"))) {
      if (Date.now() > deadline) throw new Error("Fixture controller did not stop hub.");
      await delay(200);
    }
  } finally {
    await server.close();
    if (persistence === "prisma") {
      const { prismaClient } = require("../../src/infrastructure/database/prisma/client");
      await prismaClient.$disconnect();
    }
  }
}
main().catch(() => {
  process.stderr.write("Isolated hub fixture initialization failed.\n");
  process.exitCode = 1;
});
