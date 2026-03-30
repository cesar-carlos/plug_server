import type { Agent, AgentStatus } from "../entities/agent.entity";

export interface AgentListFilter {
  readonly status?: AgentStatus;
  readonly search?: string;
}

export interface IAgentRepository {
  findById(agentId: string): Promise<Agent | null>;
  findByCnpjCpf(cnpjCpf: string): Promise<Agent | null>;
  findAll(filter?: AgentListFilter): Promise<Agent[]>;
  save(agent: Agent): Promise<void>;
  update(agent: Agent): Promise<void>;
}
