export interface ClientRegistrationApprovalToken {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface IClientRegistrationApprovalTokenRepository {
  save(token: ClientRegistrationApprovalToken): Promise<void>;
  findById(id: string): Promise<ClientRegistrationApprovalToken | null>;
  deleteById(id: string): Promise<void>;
}
