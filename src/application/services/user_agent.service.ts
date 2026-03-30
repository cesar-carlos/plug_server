import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import { conflict, notFound } from "../../shared/errors/http_errors";
import { type Result, ok, err } from "../../shared/errors/result";

export interface EnrichedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly cnpjCpf: string;
  readonly observation: string | undefined;
  readonly status: Agent["status"];
}

export class UserAgentService {
  constructor(
    private readonly agentRepository: IAgentRepository,
    private readonly agentIdentityRepository: IAgentIdentityRepository,
  ) {}

  async listByUserId(userId: string): Promise<EnrichedAgent[]> {
    const agentIds = await this.agentIdentityRepository.listAgentIdsByUserId(userId);
    const agents: EnrichedAgent[] = [];

    for (const agentId of agentIds) {
      const agent = await this.agentRepository.findById(agentId);
      if (agent) {
        agents.push({
          agentId: agent.agentId,
          name: agent.name,
          cnpjCpf: agent.cnpjCpf,
          observation: agent.observation,
          status: agent.status,
        });
      }
    }

    return agents;
  }

  async addAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    for (const agentId of agentIds) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        return err(notFound(`Agent ${agentId}`));
      }

      const currentOwner = await this.agentIdentityRepository.findOwnerUserId(agentId);
      if (currentOwner && currentOwner !== userId) {
        return err(conflict(`Agent ${agentId} is already linked to another user`));
      }
    }

    await this.agentIdentityRepository.addAgentIds(userId, agentIds);
    return ok(undefined);
  }

  async removeAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    await this.agentIdentityRepository.removeAgentIds(userId, agentIds);
    return ok(undefined);
  }

  async replaceAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    for (const agentId of agentIds) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        return err(notFound(`Agent ${agentId}`));
      }

      const currentOwner = await this.agentIdentityRepository.findOwnerUserId(agentId);
      if (currentOwner && currentOwner !== userId) {
        return err(conflict(`Agent ${agentId} is already linked to another user`));
      }
    }

    await this.agentIdentityRepository.replaceAgentIds(userId, agentIds);
    return ok(undefined);
  }
}
