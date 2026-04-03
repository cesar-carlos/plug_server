export interface ClientPasswordRecoveryToken {
  readonly id: string;
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface IClientPasswordRecoveryTokenRepository {
  save(token: ClientPasswordRecoveryToken): Promise<void>;
  findById(id: string): Promise<ClientPasswordRecoveryToken | null>;
  deleteById(id: string): Promise<void>;
  deleteByClientId(clientId: string): Promise<void>;
}
