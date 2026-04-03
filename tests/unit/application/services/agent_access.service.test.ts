import { describe, expect, it } from "vitest";

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
