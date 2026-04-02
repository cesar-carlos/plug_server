import type { Agent } from "../../domain/entities/agent.entity";
import type { IAgentRepository } from "../../domain/repositories/agent.repository.interface";
import type { IAgentIdentityRepository } from "../../domain/repositories/agent_identity.repository.interface";

export interface EnrichedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly tradeName: string | undefined;
  readonly document: string | undefined;
  readonly notes: string | undefined;
  /** Legacy alias for document. */
  readonly cnpjCpf: string | undefined;
  /** Legacy alias for notes. */
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
        tradeName: agent.tradeName,
        document: agent.document,
        notes: agent.notes,
        cnpjCpf: agent.document,
        observation: agent.notes,
        status: agent.status,
      }));
  }
}
