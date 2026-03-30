import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
} from "../../domain/repositories/agent.repository.interface";

export class InMemoryAgentRepository implements IAgentRepository {
  private readonly agentsById = new Map<string, Agent>();

  async findById(agentId: string): Promise<Agent | null> {
    return this.agentsById.get(agentId) ?? null;
  }

  async findByCnpjCpf(cnpjCpf: string): Promise<Agent | null> {
    for (const agent of this.agentsById.values()) {
      if (agent.cnpjCpf === cnpjCpf) return agent;
    }
    return null;
  }

  async findAll(filter?: AgentListFilter): Promise<Agent[]> {
    let agents = [...this.agentsById.values()];

    if (filter?.status) {
      agents = agents.filter((a) => a.status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase();
      agents = agents.filter(
        (a) => a.name.toLowerCase().includes(q) || a.cnpjCpf.includes(filter.search!),
      );
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(agent: Agent): Promise<void> {
    this.agentsById.set(agent.agentId, agent);
  }

  async update(agent: Agent): Promise<void> {
    this.agentsById.set(agent.agentId, agent);
  }

  clear(): void {
    this.agentsById.clear();
  }
}
