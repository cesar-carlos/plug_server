import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";
import { agentAlreadyLinked, agentNotFound } from "../../shared/errors/http_errors";
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

  /** Whether the user has an explicit user↔agent binding (does not require agent status active). */
  async isAgentLinkedToUser(userId: string, agentId: string): Promise<boolean> {
    return this.agentIdentityRepository.hasAccess(userId, agentId);
  }

  async listAgentIdsByUserId(userId: string): Promise<string[]> {
    return this.agentIdentityRepository.listAgentIdsByUserId(userId);
  }

  async listByUserId(userId: string): Promise<EnrichedAgent[]> {
    const agentIds = await this.agentIdentityRepository.listAgentIdsByUserId(userId);
    const agents = await this.agentRepository.findByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.agentId, agent] as const));

    return agentIds
      .map((agentId) => agentsById.get(agentId))
      .filter((agent): agent is Agent => agent !== undefined)
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        cnpjCpf: agent.cnpjCpf,
        observation: agent.observation,
        status: agent.status,
      }));
  }

  async addAgentIds(userId: string, agentIds: string[]): Promise<Result<void>> {
    for (const agentId of agentIds) {
      const agent = await this.agentRepository.findById(agentId);
      if (!agent) {
        return err(agentNotFound(agentId));
      }
    }

    const mutation = await this.agentIdentityRepository.addAgentIds(userId, agentIds);
    if (mutation.kind === "agent_not_found") {
      return err(agentNotFound(mutation.agentId));
    }
    if (mutation.kind === "agent_bound_to_other_user") {
      return err(agentAlreadyLinked(mutation.agentId));
    }

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
        return err(agentNotFound(agentId));
      }
    }

    const mutation = await this.agentIdentityRepository.replaceAgentIds(userId, agentIds);
    if (mutation.kind === "agent_not_found") {
      return err(agentNotFound(mutation.agentId));
    }
    if (mutation.kind === "agent_bound_to_other_user") {
      return err(agentAlreadyLinked(mutation.agentId));
    }

    return ok(undefined);
  }
}
