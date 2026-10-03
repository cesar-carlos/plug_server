import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../../src/shared/config/env";
import { prismaClient } from "../../../../src/infrastructure/database/prisma/client";
import { PrismaAgentRepository } from "../../../../src/infrastructure/repositories/prisma_agent.repository";
import { PrismaClientRepository } from "../../../../src/infrastructure/repositories/prisma_client.repository";

describe.skipIf(env.persistenceMode !== "prisma")(
  "REST Prisma scopes and fresh projections",
  () => {
    const ownerId = randomUUID(),
      otherId = randomUUID(),
      clientId = randomUUID();
    const agentIds = [randomUUID(), randomUUID(), randomUUID()];
    const agents = new PrismaAgentRepository(),
      clients = new PrismaClientRepository();
    beforeAll(async () => {
      await prismaClient.$queryRaw`SELECT 1`;
      await prismaClient.user.createMany({
        data: [ownerId, otherId].map((id) => ({
          id,
          email: `rest-query-${id}@test.invalid`,
          passwordHash: "private-test-hash",
          status: "active" as const,
        })),
      });
      await prismaClient.agent.createMany({
        data: agentIds.map((agentId, i) => ({
          agentId,
          name: "Scope Search",
          status: i === 1 ? ("inactive" as const) : ("active" as const),
        })),
      });
      await prismaClient.agentIdentity.createMany({
        data: agentIds.map((agentId, i) => ({ agentId, userId: i === 2 ? otherId : ownerId })),
      });
      await prismaClient.client.create({
        data: {
          id: clientId,
          userId: ownerId,
          email: `rest-query-${clientId}@test.invalid`,
          passwordHash: "private-test-hash",
          name: "Projection",
          lastName: "Search",
          mobile: "123",
          status: "active",
        },
      });
    });
    afterAll(async () => {
      await prismaClient.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
      await prismaClient.agent.deleteMany({ where: { agentId: { in: agentIds } } });
    });

    it("applies the same scope/filter to page and count without reading all linked IDs", async () => {
      const pg = createRequire(__filename)("pg") as {
        Client: { prototype: { query: (...args: unknown[]) => unknown } };
      };
      const original = pg.Client.prototype.query,
        queries: string[] = [];
      pg.Client.prototype.query = function (...args: unknown[]): unknown {
        const arg = args[0];
        if (typeof arg === "string") queries.push(arg);
        else if (
          arg !== null &&
          typeof arg === "object" &&
          "text" in arg &&
          typeof arg.text === "string"
        )
          queries.push(arg.text);
        return Reflect.apply(original, this, args);
      };
      try {
        const scope = { kind: "user" as const, userId: ownerId },
          filter = { search: "Scope Search", pageSize: 1 };
        const actual = await agents.findCatalogPage(scope, filter);
        expect(queries).toHaveLength(2);
        expect(queries.every((sql) => sql.includes("agent_identities"))).toBe(true);
        const legacy = await agents.findAll({ ...filter, agentIds: agentIds.slice(0, 2) });
        expect(actual).toEqual(legacy);
        expect((await agents.findCatalogPage(scope, { ...filter, status: "active" })).total).toBe(
          1,
        );
        expect((await agents.findCatalogPage(scope, { ...filter, page: 99 })).items).toEqual([]);
        expect((await agents.findCatalogPage({ kind: "user", userId: randomUUID() })).total).toBe(
          0,
        );
        expect(
          (await agents.findCatalogPage({ kind: "all" }, { search: "Scope Search" })).total,
        ).toBe(3);
        await prismaClient.agentIdentity.delete({ where: { agentId: agentIds[0]! } });
        expect((await agents.findCatalogPage(scope, filter)).total).toBe(1);
        await prismaClient.agentIdentity.create({
          data: { agentId: agentIds[0]!, userId: ownerId },
        });
        expect((await agents.findCatalogPage(scope, filter)).total).toBe(2);
        const plan =
          await prismaClient.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT a.agent_id FROM agents a WHERE EXISTS (SELECT 1 FROM agent_identities i WHERE i.agent_id = a.agent_id AND i.user_id = ${ownerId}) ORDER BY a.name, a.agent_id LIMIT 20`;
        await mkdir("tmp", { recursive: true });
        await writeFile("tmp/rest-query-plans.json", JSON.stringify(plan, null, 2));
      } finally {
        pg.Client.prototype.query = original;
      }
    });

    it("returns only managed response fields while preserving optional columns and fresh status", async () => {
      const snapshot = await clients.findManagedClient(clientId);
      expect(snapshot).toMatchObject({ id: clientId, mobile: "123", status: "active" });
      expect(snapshot).not.toHaveProperty("passwordHash");
      expect(snapshot).not.toHaveProperty("credentialsUpdatedAt");
      expect(snapshot).not.toHaveProperty("thumbnailUrl");
      const page = await clients.listManagedClients(ownerId, { search: " Search ", pageSize: 1 });
      expect(page.items).toEqual([snapshot]);
      expect(page.total).toBe(1);
      await prismaClient.client.update({ where: { id: clientId }, data: { status: "blocked" } });
      expect((await clients.findActiveSnapshotById(clientId))?.status).toBe("blocked");
      expect((await clients.listManagedClients(ownerId, { status: "active" })).total).toBe(0);
      expect((await clients.findById(clientId))?.passwordHash).toBe("private-test-hash");
    });
  },
);
