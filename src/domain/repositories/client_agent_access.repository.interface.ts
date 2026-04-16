export interface ClientAgentAccessRecord {
  readonly clientId: string;
  readonly agentId: string;
  readonly approvedAt: Date;
}

export interface IClientAgentAccessRepository {
  hasAccess(clientId: string, agentId: string): Promise<boolean>;
  /** Agent IDs among `agentIds` that currently have an approved access row for this client. */
  listAccessAgentIdsForClientIn(clientId: string, agentIds: readonly string[]): Promise<string[]>;
  listAgentIdsByClientId(clientId: string): Promise<string[]>;
  listByAgentId(agentId: string): Promise<ClientAgentAccessRecord[]>;
  addAccess(clientId: string, agentId: string, approvedAt?: Date): Promise<void>;
  removeAccess(clientId: string, agentId: string): Promise<void>;
  removeAgentIds(clientId: string, agentIds: string[]): Promise<void>;
}
