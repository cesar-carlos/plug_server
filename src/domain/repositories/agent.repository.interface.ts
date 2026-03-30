import type { Agent, AgentStatus } from "../entities/agent.entity";

export interface AgentListFilter {
  readonly status?: AgentStatus;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PaginatedAgentList {
  readonly items: Agent[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface IAgentRepository {
  findById(agentId: string): Promise<Agent | null>;
  findByIds(agentIds: string[]): Promise<Agent[]>;
  findByCnpjCpf(cnpjCpf: string): Promise<Agent | null>;
  findAll(filter?: AgentListFilter): Promise<PaginatedAgentList>;
  save(agent: Agent): Promise<void>;
  update(agent: Agent): Promise<void>;
}
