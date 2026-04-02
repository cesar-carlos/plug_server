export interface ClientAgentAccessApprovalToken {
  readonly id: string;
  readonly requestId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface IClientAgentAccessApprovalTokenRepository {
  save(token: ClientAgentAccessApprovalToken): Promise<void>;
  findById(id: string): Promise<ClientAgentAccessApprovalToken | null>;
  deleteById(id: string): Promise<void>;
}
