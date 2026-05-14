import type { Agent, AgentStatus } from "../entities/agent.entity";

export interface ClientAgentAccessRecord {
  readonly clientId: string;
  readonly agentId: string;
  readonly approvedAt: Date;
  /**
   * Per-(client, agent) bearer token used by the SQL bridge as
   * `sql.execute params.client_token`. `null` means the client has not stored
   * a token (e.g. agent does not require auth or the client cleared it).
   */
  readonly clientToken: string | null;
}

export interface ClientApprovedAgentListFilter {
  readonly status?: AgentStatus;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ClientApprovedAgentListItem {
  readonly agent: Agent;
  readonly hasClientToken: boolean;
}

export interface ClientApprovedAgentListPage {
  readonly items: ClientApprovedAgentListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface IClientAgentAccessRepository {
  hasAccess(clientId: string, agentId: string): Promise<boolean>;
  /** Agent IDs among `agentIds` that currently have an approved access row for this client. */
  listAccessAgentIdsForClientIn(clientId: string, agentIds: readonly string[]): Promise<string[]>;
  listAgentIdsByClientId(clientId: string): Promise<string[]>;
  /**
   * Bulk presence map: for each agentId in input, returns whether the client
   * has stored a non-null/non-empty `client_token`. Used by the listing
   * endpoint to expose `hasClientToken` without leaking the value itself.
   */
  listClientTokenPresenceForClientIn(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, boolean>>;
  /** Optimized approved-agent page for `GET /client/me/agents` when backed by SQL. */
  listApprovedAgentsPageByClient?(
    clientId: string,
    filter?: ClientApprovedAgentListFilter,
  ): Promise<ClientApprovedAgentListPage>;
  /** Optimized active-client ID projection for realtime fan-out when backed by SQL. */
  listActiveClientIdsByAgentId?(agentId: string): Promise<string[]>;
  listByAgentId(agentId: string): Promise<ClientAgentAccessRecord[]>;
  /** Returns the per-(client, agent) record (including its `client_token`) when access exists. */
  findByClientAndAgent(clientId: string, agentId: string): Promise<ClientAgentAccessRecord | null>;
  addAccess(clientId: string, agentId: string, approvedAt?: Date): Promise<void>;
  /**
   * Replaces the stored `client_token` for an existing access row. Pass `null`
   * to clear it. Returns `true` when the row exists and was updated; `false`
   * when there is no access row for `(clientId, agentId)`.
   */
  setClientToken(clientId: string, agentId: string, clientToken: string | null): Promise<boolean>;
  removeAccess(clientId: string, agentId: string): Promise<void>;
  removeAgentIds(clientId: string, agentIds: string[]): Promise<void>;
}
