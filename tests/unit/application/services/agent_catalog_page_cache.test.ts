import { describe, expect, it, vi } from "vitest";
import type { AgentCatalogGeneration } from "../../../../src/application/ports/agent_catalog_generation.port";
import { AgentCatalogPageCache } from "../../../../src/application/services/agent_catalog_page_cache";
import { AgentCatalogService } from "../../../../src/application/services/agent_catalog.service";
import { MemoryAgentCatalogGeneration } from "../../../../src/application/services/memory_agent_catalog_generation";
import { Agent } from "../../../../src/domain/entities/agent.entity";
import type { IAgentCatalogQueryPort } from "../../../../src/domain/ports/agent_catalog_query.port";
import type { PaginatedAgentList } from "../../../../src/domain/repositories/agent.repository.interface";
import { InMemoryAgentIdentityRepository } from "../../../../src/infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import type { JwtAccessPayload } from "../../../../src/shared/utils/jwt";

const admin: JwtAccessPayload = { sub: "admin", role: "admin", tokenType: "access" };
const user: JwtAccessPayload = { sub: "user-1", role: "user", tokenType: "access" };
const emptyPage = (page = 1): PaginatedAgentList => ({
  items: [],
  total: 0,
  page,
  pageSize: 20,
});

const catalogService = (
  generation: AgentCatalogGeneration,
  findCatalogPage: IAgentCatalogQueryPort["findCatalogPage"],
): { readonly service: AgentCatalogService; readonly pages: AgentCatalogPageCache } => {
  const pages = new AgentCatalogPageCache(generation);
  const service = new AgentCatalogService(
    new InMemoryAgentRepository(),
    { findCatalogPage },
    {
      pages,
    },
  );
  return { service, pages };
};

describe("agent catalog page cache", () => {
  it("reuses a page for the same principal and filter and misses otherwise", async () => {
    const findCatalogPage = vi.fn(async () => emptyPage());
    const { service, pages } = catalogService(new MemoryAgentCatalogGeneration(), findCatalogPage);

    await service.listVisiblePage(admin, { page: 1 });
    await service.listVisiblePage(admin, { page: 1 });
    expect(findCatalogPage).toHaveBeenCalledTimes(1);

    await service.listVisiblePage(user, { page: 1 });
    await service.listVisiblePage(admin, { page: 2 });
    await service.listVisiblePage(admin, { status: "active" });
    expect(findCatalogPage).toHaveBeenCalledTimes(4);

    await pages.bump();
    await service.listVisiblePage(admin, { page: 1 });
    expect(findCatalogPage).toHaveBeenCalledTimes(5);
  });

  it("does not store a page when the generation cannot be confirmed", async () => {
    const generation: AgentCatalogGeneration = {
      read: async () => null,
      bump: async () => undefined,
    };
    const findCatalogPage = vi.fn(async () => emptyPage());
    const { service } = catalogService(generation, findCatalogPage);
    await service.listVisiblePage(admin);
    await service.listVisiblePage(admin);
    expect(findCatalogPage).toHaveBeenCalledTimes(2);
  });

  it("bumps on save, update, a real profile commit, and a new identity binding", async () => {
    let bumps = 0;
    const notify = (): void => {
      bumps += 1;
    };
    const agents = new InMemoryAgentRepository(notify);
    const identities = new InMemoryAgentIdentityRepository(notify);
    const created = Agent.create({ agentId: "agent-1", name: "One" });
    await agents.save(created);
    const renamed = Agent.create({ agentId: "agent-1", name: "Two", profileVersion: 1 });
    await agents.update(renamed);
    const committed = Agent.create({ agentId: "agent-1", name: "Three", profileVersion: 2 });
    const commit = {
      mode: "update" as const,
      previousProfileVersion: 1,
      nextAgent: committed,
      source: "test",
      patchFingerprint: "fingerprint",
      changedFields: ["name"],
      snapshotJson: {},
      dedupeKey: "dedupe-1",
    };
    expect((await agents.commitAgentProfileChange(commit)).status).toBe("committed");
    expect((await agents.commitAgentProfileChange(commit)).status).toBe("idempotent");
    expect(await identities.bindIfUnbound("agent-1", "user-1")).toBe("bound");
    expect(await identities.bindIfUnbound("agent-1", "user-1")).toBe("already_bound_to_user");
    expect(bumps).toBe(4);
  });
});
