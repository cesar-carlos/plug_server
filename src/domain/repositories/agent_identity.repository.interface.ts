import type { Agent } from "../entities/agent.entity";

export type BindAgentIdentityStatus = "bound" | "already_bound_to_user" | "bound_to_other_user";

export interface UserAgentListFilter {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface UserAgentIdListPage {
  readonly agentIds: readonly string[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface IAgentIdentityRepository {
  findOwnerUserId(agentId: string): Promise<string | null>;
  /** Resolves owner user id per agent id; missing agents are omitted from the map. */
  findOwnerUserIdsByAgentIds(agentIds: readonly string[]): Promise<Map<string, string>>;
  bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus>;

  hasAccess(userId: string, agentId: string): Promise<boolean>;
  listAgentIdsByUserId(userId: string): Promise<string[]>;
  listAgentIdsPageByUserId(
    userId: string,
    filter?: UserAgentListFilter,
  ): Promise<UserAgentIdListPage>;
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
