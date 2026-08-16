import { describe, expect, it, vi } from "vitest";

import { ClientAgentAccessQueryService } from "../../../../src/application/services/client_agent_access_query.service";
import { Agent } from "../../../../src/domain/entities/agent.entity";
import { ClientAgentAccessRequest } from "../../../../src/domain/entities/client_agent_access_request.entity";
import type { IAgentRepository } from "../../../../src/domain/repositories/agent.repository.interface";
import type {
  ClientAgentAccessRecord,
  IClientAgentAccessRepository,
} from "../../../../src/domain/repositories/client_agent_access.repository.interface";
import type { IClientAgentAccessRequestRepository } from "../../../../src/domain/repositories/client_agent_access_request.repository.interface";
import type { IClientRepository } from "../../../../src/domain/repositories/client.repository.interface";

const clientId = "client-1";
const agentId = "agent-1";
const otherAgentId = "agent-missing";

const makeAgent = (id: string, name = `Agent ${id}`): Agent => Agent.create({ agentId: id, name });

const makeAccess = (
  accessClientId: string,
  accessAgentId: string,
  clientToken: string | null = null,
): ClientAgentAccessRecord => ({
  clientId: accessClientId,
  agentId: accessAgentId,
  approvedAt: new Date("2026-01-01T00:00:00.000Z"),
  clientToken,
});

const makeService = (deps: {
  readonly agentRepository?: Partial<IAgentRepository>;
  readonly clientRepository?: Partial<IClientRepository>;
  readonly accessRepository?: Partial<IClientAgentAccessRepository>;
  readonly requestRepository?: Partial<IClientAgentAccessRequestRepository>;
}): ClientAgentAccessQueryService =>
  new ClientAgentAccessQueryService(
    {
      findById: vi.fn(),
      findByIds: vi.fn().mockResolvedValue([]),
      findAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      ...deps.agentRepository,
    } as never,
    {
      findActiveIdsByIds: vi.fn().mockResolvedValue([]),
      ...deps.clientRepository,
    } as never,
    {
      hasAccess: vi.fn().mockResolvedValue(false),
      listAgentIdsByClientId: vi.fn().mockResolvedValue([]),
      listByAgentId: vi.fn().mockResolvedValue([]),
      listClientTokenPresenceForClientIn: vi.fn().mockResolvedValue(new Map()),
      findByClientAndAgent: vi.fn().mockResolvedValue(null),
      ...deps.accessRepository,
    } as never,
    {
      listByClientId: vi.fn().mockResolvedValue([]),
      ...deps.requestRepository,
    } as never,
  );

describe("ClientAgentAccessQueryService", () => {
  it("lists approved agent ids from the access repository", async () => {
    const listAgentIdsByClientId = vi.fn().mockResolvedValue([agentId]);
    const service = makeService({ accessRepository: { listAgentIdsByClientId } });

    await expect(service.listApprovedAgentIds(clientId)).resolves.toEqual([agentId]);
    expect(listAgentIdsByClientId).toHaveBeenCalledWith(clientId);
  });

  it("lists approved client ids for an agent", async () => {
    const listByAgentId = vi.fn().mockResolvedValue([makeAccess(clientId, agentId)]);
    const service = makeService({ accessRepository: { listByAgentId } });

    await expect(service.listApprovedClientIdsForAgent(agentId)).resolves.toEqual([clientId]);
  });

  it("uses the optimized active-client projection when the repository provides it", async () => {
    const listActiveClientIdsByAgentId = vi.fn().mockResolvedValue(["active-client"]);
    const listByAgentId = vi.fn();
    const service = makeService({
      accessRepository: { listActiveClientIdsByAgentId, listByAgentId },
    });

    await expect(service.listActiveApprovedClientIdsForAgent(agentId)).resolves.toEqual([
      "active-client",
    ]);
    expect(listByAgentId).not.toHaveBeenCalled();
  });

  it("falls back to filtering active clients when the optimized projection is absent", async () => {
    const findActiveIdsByIds = vi.fn().mockResolvedValue([clientId]);
    const listByAgentId = vi
      .fn()
      .mockResolvedValue([makeAccess(clientId, agentId), makeAccess("blocked-client", agentId)]);
    const service = makeService({
      clientRepository: { findActiveIdsByIds },
      accessRepository: { listByAgentId },
    });

    await expect(service.listActiveApprovedClientIdsForAgent(agentId)).resolves.toEqual([clientId]);
    expect(findActiveIdsByIds).toHaveBeenCalledWith([clientId, "blocked-client"]);
  });

  it("skips approved agent ids that no longer exist in the catalog", async () => {
    const persisted = makeAgent(agentId);
    const service = makeService({
      agentRepository: { findByIds: vi.fn().mockResolvedValue([persisted]) },
      accessRepository: {
        listAgentIdsByClientId: vi.fn().mockResolvedValue([agentId, otherAgentId]),
      },
    });

    await expect(service.listApprovedAgents(clientId)).resolves.toEqual([persisted]);
  });

  it("returns the optimized approved-agent page without a live refresh", async () => {
    const pageResult = {
      items: [{ agent: makeAgent(agentId), hasClientToken: true }],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    const listApprovedAgentsPageByClient = vi.fn().mockResolvedValue(pageResult);
    const service = makeService({ accessRepository: { listApprovedAgentsPageByClient } });

    await expect(service.listApprovedAgentsPage(clientId)).resolves.toEqual(pageResult);
    expect(listApprovedAgentsPageByClient).toHaveBeenCalledWith(clientId, undefined);
  });

  it("refreshes optimized approved-agent page items when requested", async () => {
    const pageResult = {
      items: [{ agent: makeAgent(agentId), hasClientToken: false }],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    const listApprovedAgentsPageByClient = vi.fn().mockResolvedValue(pageResult);
    const service = makeService({ accessRepository: { listApprovedAgentsPageByClient } });

    const result = await service.listApprovedAgentsPage(clientId, undefined, {
      refreshOnline: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.agent.agentId).toBe(agentId);
  });

  it("builds an approved-agent page from catalog listing when the optimized query is absent", async () => {
    const agent = makeAgent(agentId);
    const findAll = vi.fn().mockResolvedValue({
      items: [agent],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const listClientTokenPresenceForClientIn = vi
      .fn()
      .mockResolvedValue(new Map([[agentId, true]]));
    const service = makeService({
      agentRepository: { findAll },
      accessRepository: {
        listAgentIdsByClientId: vi.fn().mockResolvedValue([agentId]),
        listClientTokenPresenceForClientIn,
      },
    });

    const result = await service.listApprovedAgentsPage(clientId, { search: "Agent" });

    expect(findAll).toHaveBeenCalledWith({ search: "Agent", agentIds: [agentId] });
    expect(result.items).toEqual([{ agent, hasClientToken: true }]);
  });

  it("refreshes the fallback approved-agent page when requested", async () => {
    const agent = makeAgent(agentId);
    const service = makeService({
      agentRepository: {
        findAll: vi.fn().mockResolvedValue({
          items: [agent],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      },
      accessRepository: {
        listAgentIdsByClientId: vi.fn().mockResolvedValue([agentId]),
        listClientTokenPresenceForClientIn: vi.fn().mockResolvedValue(new Map()),
      },
    });

    const result = await service.listApprovedAgentsPage(clientId, undefined, {
      refreshOnline: true,
    });
    expect(result.items).toEqual([{ agent, hasClientToken: false }]);
  });

  it("denies detail lookup when the client has no access", async () => {
    const service = makeService({
      accessRepository: { hasAccess: vi.fn().mockResolvedValue(false) },
    });
    const result = await service.findApprovedAgent(clientId, agentId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AGENT_ACCESS_DENIED");
    }
  });

  it("returns not found when access exists but the agent catalog row is missing", async () => {
    const service = makeService({
      agentRepository: { findById: vi.fn().mockResolvedValue(null) },
      accessRepository: { hasAccess: vi.fn().mockResolvedValue(true) },
    });
    const result = await service.findApprovedAgent(clientId, agentId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("delegates token presence lookups to the access repository", async () => {
    const presence = new Map([[agentId, true]]);
    const listClientTokenPresenceForClientIn = vi.fn().mockResolvedValue(presence);
    const service = makeService({ accessRepository: { listClientTokenPresenceForClientIn } });

    await expect(service.getClientTokenPresenceForAgents(clientId, [agentId])).resolves.toBe(
      presence,
    );
  });

  it("treats missing or empty client tokens as absent", async () => {
    const findByClientAndAgent = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeAccess(clientId, agentId, ""))
      .mockResolvedValueOnce(makeAccess(clientId, agentId, "opaque-token"));
    const service = makeService({ accessRepository: { findByClientAndAgent } });

    await expect(service.hasClientTokenForAgent(clientId, agentId)).resolves.toBe(false);
    await expect(service.hasClientTokenForAgent(clientId, agentId)).resolves.toBe(false);
    await expect(service.hasClientTokenForAgent(clientId, agentId)).resolves.toBe(true);
  });

  it("includes agent names on request records when the catalog has them", async () => {
    const named = makeAgent(agentId, "Named Agent");
    const unnamedAgentId = "agent-unnamed";
    const listByClientId = vi
      .fn()
      .mockResolvedValue([
        ClientAgentAccessRequest.create({ clientId, agentId }),
        ClientAgentAccessRequest.create({ clientId, agentId: unnamedAgentId }),
      ]);
    const service = makeService({
      agentRepository: {
        findByIds: vi.fn().mockResolvedValue([named]),
      },
      requestRepository: { listByClientId },
    });

    const records = await service.listRequests(clientId);
    expect(records).toHaveLength(2);
    expect(records[0]?.agentName).toBe("Named Agent");
    expect(records[1]?.agentName).toBeUndefined();
  });
});
