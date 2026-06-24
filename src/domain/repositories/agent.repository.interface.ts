import type { Agent, AgentStatus } from "../entities/agent.entity";
import type { AgentProfileCommitInput, AgentProfileCommitResult } from "./agent_profile_commit";

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

/**
 * Minimal projection used by hot-path access checks
 * (`AgentAccessService.assertPrincipalAccess`). Avoids loading wide profile
 * and address columns just to verify existence + status.
 */
export interface AgentAccessSnapshot {
  readonly agentId: string;
  readonly status: AgentStatus;
}

export type PrincipalAccessQuery =
  | { readonly type: "user"; readonly userId: string }
  | { readonly type: "client"; readonly clientId: string };

export type PrincipalAccessCheckResult =
  | { readonly outcome: "granted"; readonly snapshot: AgentAccessSnapshot }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "inactive" }
  | { readonly outcome: "denied" };

export interface IAgentRepository {
  findById(agentId: string): Promise<Agent | null>;
  findByIds(agentIds: string[]): Promise<Agent[]>;
  findByDocument(document: string): Promise<Agent | null>;
  findAll(filter?: AgentListFilter): Promise<PaginatedAgentList>;
  /** Lightweight projection for hot-path access checks (consumer guard, REST bridge). */
  findAccessSnapshotById(agentId: string): Promise<AgentAccessSnapshot | null>;
  /**
   * Single round-trip access check: agent existence, active status, and principal
   * binding. Used by `AgentAccessService` on cache miss (Prisma implementation).
   */
  findPrincipalAccessCheck?(
    agentId: string,
    principal: PrincipalAccessQuery,
  ): Promise<PrincipalAccessCheckResult>;
  save(agent: Agent): Promise<void>;
  update(agent: Agent): Promise<void>;
  commitAgentProfileChange(input: AgentProfileCommitInput): Promise<AgentProfileCommitResult>;
}
