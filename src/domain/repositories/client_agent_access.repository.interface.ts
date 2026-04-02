export interface ClientAgentAccessRecord {
  readonly clientId: string;
  readonly agentId: string;
  readonly approvedAt: Date;
}

export interface IClientAgentAccessRepository {
  hasAccess(clientId: string, agentId: string): Promise<boolean>;
  listAgentIdsByClientId(clientId: string): Promise<string[]>;
  listByAgentId(agentId: string): Promise<ClientAgentAccessRecord[]>;
  addAccess(clientId: string, agentId: string, approvedAt?: Date): Promise<void>;
  removeAccess(clientId: string, agentId: string): Promise<void>;
  removeAgentIds(clientId: string, agentIds: string[]): Promise<void>;
}
