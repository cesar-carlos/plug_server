import type { Agent } from "../../domain/entities/agent.entity";
import type {
  AgentListFilter,
  IAgentRepository,
  PaginatedAgentList,
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

  async findByIds(agentIds: string[]): Promise<Agent[]> {
    return [...new Set(agentIds)]
      .map((agentId) => this.agentsById.get(agentId) ?? null)
      .filter((agent): agent is Agent => agent !== null);
  }

  async findAll(filter?: AgentListFilter): Promise<PaginatedAgentList> {
    let agents = [...this.agentsById.values()];
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, filter?.pageSize ?? 20);

    if (filter?.agentIds !== undefined) {
      if (filter.agentIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
      const allowed = new Set(filter.agentIds);
      agents = agents.filter((a) => allowed.has(a.agentId));
    }

    if (filter?.status) {
      agents = agents.filter((a) => a.status === filter.status);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase();
      agents = agents.filter(
        (a) => a.name.toLowerCase().includes(q) || a.cnpjCpf.includes(filter.search!),
      );
    }

    const sorted = agents.sort((a, b) => a.name.localeCompare(b.name));
    const start = (page - 1) * pageSize;

    return {
      items: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
      pageSize,
    };
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
