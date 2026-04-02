import type { Agent, AgentStatus } from "../entities/agent.entity";

export interface AgentListFilter {
  readonly status?: AgentStatus;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
  /** When set, only agents whose `agentId` is in this list are included (after other filters). */
  readonly agentIds?: readonly string[];
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
  findByDocument(document: string): Promise<Agent | null>;
  findAll(filter?: AgentListFilter): Promise<PaginatedAgentList>;
  save(agent: Agent): Promise<void>;
  update(agent: Agent): Promise<void>;
}
