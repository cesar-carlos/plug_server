import type { Agent } from "../entities/agent.entity";

export type BindAgentIdentityStatus = "bound" | "already_bound_to_user" | "bound_to_other_user";

export interface IAgentIdentityRepository {
  findOwnerUserId(agentId: string): Promise<string | null>;
  bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus>;

  hasAccess(userId: string, agentId: string): Promise<boolean>;
  listAgentIdsByUserId(userId: string): Promise<string[]>;
  addAgentIds(userId: string, agentIds: string[]): Promise<void>;
  removeAgentIds(userId: string, agentIds: string[]): Promise<void>;
  replaceAgentIds(userId: string, agentIds: string[]): Promise<void>;
}

export interface EnrichedAgentAccess {
  readonly agentId: string;
  readonly name: string;
  readonly cnpjCpf: string;
  readonly observation: string | undefined;
  readonly status: Agent["status"];
  readonly boundAt: Date;
}
