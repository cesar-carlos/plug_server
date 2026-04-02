import type { Agent } from "../entities/agent.entity";

export type BindAgentIdentityStatus = "bound" | "already_bound_to_user" | "bound_to_other_user";

export interface IAgentIdentityRepository {
  findOwnerUserId(agentId: string): Promise<string | null>;
  bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus>;

  hasAccess(userId: string, agentId: string): Promise<boolean>;
  listAgentIdsByUserId(userId: string): Promise<string[]>;
}

export interface EnrichedAgentAccess {
  readonly agentId: string;
  readonly name: string;
  readonly tradeName: string | undefined;
  readonly document: string | undefined;
  readonly notes: string | undefined;
  readonly status: Agent["status"];
  readonly boundAt: Date;
}
