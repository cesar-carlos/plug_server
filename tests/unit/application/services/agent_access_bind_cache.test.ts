import type * as EnvModule from "../../../../src/shared/config/env";
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { AgentAccessService } from "../../../../src/application/services/agent_access.service";
import { InMemoryAgentIdentityRepository } from "../../../../src/infrastructure/repositories/in_memory_agent_identity.repository";
import { InMemoryAgentRepository } from "../../../../src/infrastructure/repositories/in_memory_agent.repository";
import { InMemoryClientAgentAccessRepository } from "../../../../src/infrastructure/repositories/in_memory_client_agent_access.repository";

vi.mock("../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      agentRegisterBindCacheTtlMs: 60_000,
      agentRegisterBindCacheMaxSize: 500,
    },
  };
});

describe("AgentAccessService bind-register cache", () => {
  const userId = "35fdbf4a-8f33-45b6-a53b-a2cfd7a52d3f";
  const agentId = "3183a9f2-429b-46d6-a339-3580e5e5cb99";

  it("second bindOwnershipOnRegister skips bindIfUnbound when cache warm", async () => {
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

    const spy = vi.spyOn(agentIdentityRepository, "bindIfUnbound");

    const first = await service.bindOwnershipOnRegister(userId, agentId);
    expect(first.ok).toBe(true);
    const second = await service.bindOwnershipOnRegister(userId, agentId);
    expect(second.ok).toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("invalidateAccessCache clears bind cache so bindIfUnbound runs again", async () => {
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

    const spy = vi.spyOn(agentIdentityRepository, "bindIfUnbound");

    await service.bindOwnershipOnRegister(userId, agentId);
    await service.bindOwnershipOnRegister(userId, agentId);
    expect(spy).toHaveBeenCalledTimes(1);

    service.invalidateAccessCache("user", userId, agentId);
    await service.bindOwnershipOnRegister(userId, agentId);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("invalidateAccessCacheForUser clears bind cache so bindIfUnbound runs again", async () => {
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

    const spy = vi.spyOn(agentIdentityRepository, "bindIfUnbound");

    await service.bindOwnershipOnRegister(userId, agentId);
    await service.bindOwnershipOnRegister(userId, agentId);
    expect(spy).toHaveBeenCalledTimes(1);

    service.invalidateAccessCacheForUser(userId);
    await service.bindOwnershipOnRegister(userId, agentId);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
