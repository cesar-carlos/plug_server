import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { AgentAccessService } from "../../../../src/application/services/agent_access.service";
import { InMemoryAgentIdentityRepository } from "../../../../src/infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import { InMemoryClientAgentAccessRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access.repository";

describe("AgentAccessService", () => {
  const userId = "35fdbf4a-8f33-45b6-a53b-a2cfd7a52d3f";
  const agentId = "3183a9f2-429b-46d6-a339-3580e5e5cb31";

  it("should create a catalog stub before binding identity when the agent row is missing", async () => {
    const agentRepository = new InMemoryAgentRepository();
    const agentIdentityRepository = new InMemoryAgentIdentityRepository();
    const clientAgentAccessRepository = new InMemoryClientAgentAccessRepository();
    const service = new AgentAccessService(
      agentRepository,
      agentIdentityRepository,
      clientAgentAccessRepository,
    );

    const result = await service.bindOwnershipOnRegister(userId, agentId);

    expect(result.ok).toBe(true);
    const catalog = await agentRepository.findById(agentId);
    expect(catalog).not.toBeNull();
    expect(catalog?.name).toBe(`Agent ${agentId}`);
    expect(await agentIdentityRepository.hasAccess(userId, agentId)).toBe(true);
  });

  it("should bind identity when catalog already exists", async () => {
    const agentRepository = new InMemoryAgentRepository();
    await agentRepository.save(
      Agent.create({
        agentId,
        name: "Existing",
      }),
    );
    const agentIdentityRepository = new InMemoryAgentIdentityRepository();
    const clientAgentAccessRepository = new InMemoryClientAgentAccessRepository();
    const service = new AgentAccessService(
      agentRepository,
      agentIdentityRepository,
      clientAgentAccessRepository,
    );

    const result = await service.bindOwnershipOnRegister(userId, agentId);

    expect(result.ok).toBe(true);
    expect((await agentRepository.findById(agentId))?.name).toBe("Existing");
    expect(await agentIdentityRepository.hasAccess(userId, agentId)).toBe(true);
  });
});

describe("AgentAccessService.assertPrincipalAccess — access cache", () => {
  const clientId = "client-aaa";
  const agentId = "agent-bbb";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildService = async (): Promise<{
    service: AgentAccessService;
    snapshotSpy: ReturnType<typeof vi.spyOn<InMemoryAgentRepository, "findAccessSnapshotById">>;
    accessSpy: ReturnType<typeof vi.spyOn<InMemoryClientAgentAccessRepository, "hasAccess">>;
    clientAgentAccessRepository: InMemoryClientAgentAccessRepository;
  }> => {
    const agentRepository = new InMemoryAgentRepository();
    await agentRepository.save(Agent.create({ agentId, name: "Test Agent" }));
    const agentIdentityRepository = new InMemoryAgentIdentityRepository();
    const clientAgentAccessRepository = new InMemoryClientAgentAccessRepository();
    await clientAgentAccessRepository.addAccess(clientId, agentId);

    const snapshotSpy = vi.spyOn(agentRepository, "findAccessSnapshotById");
    const accessSpy = vi.spyOn(clientAgentAccessRepository, "hasAccess");

    const service = new AgentAccessService(
      agentRepository,
      agentIdentityRepository,
      clientAgentAccessRepository,
    );
    return { service, snapshotSpy, accessSpy, clientAgentAccessRepository };
  };

  it("returns ok on first call and hits the DB", async () => {
    const { service, snapshotSpy, accessSpy } = await buildService();
    const result = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(result.ok).toBe(true);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });

  it("returns ok on second call without hitting the DB (cache hit)", async () => {
    const { service, snapshotSpy, accessSpy } = await buildService();
    await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    snapshotSpy.mockClear();
    accessSpy.mockClear();

    const result = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(result.ok).toBe(true);
    expect(snapshotSpy).toHaveBeenCalledTimes(0);
    expect(accessSpy).toHaveBeenCalledTimes(0);
  });

  it("re-queries the DB after cache TTL expires", async () => {
    const { service, snapshotSpy, accessSpy } = await buildService();
    await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    snapshotSpy.mockClear();
    accessSpy.mockClear();

    vi.advanceTimersByTime(31_000); // past default 30s TTL

    const result = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(result.ok).toBe(true);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache denied results — immediate re-grant is visible", async () => {
    const agentRepository = new InMemoryAgentRepository();
    await agentRepository.save(Agent.create({ agentId, name: "Test Agent" }));
    const agentIdentityRepository = new InMemoryAgentIdentityRepository();
    const clientAgentAccessRepository = new InMemoryClientAgentAccessRepository();
    // No access granted yet
    const service = new AgentAccessService(
      agentRepository,
      agentIdentityRepository,
      clientAgentAccessRepository,
    );

    const denied = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(denied.ok).toBe(false);

    // Grant access
    await clientAgentAccessRepository.addAccess(clientId, agentId);

    const allowed = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(allowed.ok).toBe(true);
  });

  it("invalidateAccessCache removes entry so next call hits the DB", async () => {
    const { service, snapshotSpy, accessSpy } = await buildService();
    await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    service.invalidateAccessCache("client", clientId, agentId);
    snapshotSpy.mockClear();
    accessSpy.mockClear();

    const result = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(result.ok).toBe(true);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidateAccessCacheForAgent clears all entries for that agent", async () => {
    const { service, snapshotSpy, accessSpy, clientAgentAccessRepository } = await buildService();
    const clientId2 = "client-ccc";
    await clientAgentAccessRepository.addAccess(clientId2, agentId);

    await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    await service.assertPrincipalAccess({ type: "client", id: clientId2 }, agentId);
    service.invalidateAccessCacheForAgent(agentId);
    snapshotSpy.mockClear();
    accessSpy.mockClear();

    await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    await service.assertPrincipalAccess({ type: "client", id: clientId2 }, agentId);
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
    expect(accessSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidateAccessCacheForUser clears all entries for that user", async () => {
    const userId = "user-aaa";
    const agentId2 = "agent-ccc";
    const agentRepository = new InMemoryAgentRepository();
    await agentRepository.save(Agent.create({ agentId, name: "Test Agent" }));
    await agentRepository.save(Agent.create({ agentId: agentId2, name: "Test Agent 2" }));
    const agentIdentityRepository = new InMemoryAgentIdentityRepository();
    const clientAgentAccessRepository = new InMemoryClientAgentAccessRepository();
    await agentIdentityRepository.bindIfUnbound(agentId, userId);
    await agentIdentityRepository.bindIfUnbound(agentId2, userId);

    const snapshotSpy = vi.spyOn(agentRepository, "findAccessSnapshotById");
    const accessSpy = vi.spyOn(agentIdentityRepository, "hasAccess");
    const service = new AgentAccessService(
      agentRepository,
      agentIdentityRepository,
      clientAgentAccessRepository,
    );

    await service.assertPrincipalAccess({ type: "user", id: userId }, agentId);
    await service.assertPrincipalAccess({ type: "user", id: userId }, agentId2);
    service.invalidateAccessCacheForUser(userId);
    snapshotSpy.mockClear();
    accessSpy.mockClear();

    await service.assertPrincipalAccess({ type: "user", id: userId }, agentId);
    await service.assertPrincipalAccess({ type: "user", id: userId }, agentId2);
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
    expect(accessSpy).toHaveBeenCalledTimes(2);
  });

  it("uses a single combined repository call on cache miss when findPrincipalAccessCheck is available", async () => {
    const agentRepository = new InMemoryAgentRepository();
    await agentRepository.save(Agent.create({ agentId, name: "Test Agent" }));
    const combinedSpy = vi.fn().mockResolvedValue({
      outcome: "granted",
      snapshot: { agentId, status: "active" as const },
    });
    agentRepository.findPrincipalAccessCheck = combinedSpy;

    const service = new AgentAccessService(
      agentRepository,
      new InMemoryAgentIdentityRepository(),
      new InMemoryClientAgentAccessRepository(),
    );

    const result = await service.assertPrincipalAccess({ type: "client", id: clientId }, agentId);
    expect(result.ok).toBe(true);
    expect(combinedSpy).toHaveBeenCalledTimes(1);
    expect(combinedSpy).toHaveBeenCalledWith(agentId, {
      type: "client",
      clientId,
    });
  });
});
