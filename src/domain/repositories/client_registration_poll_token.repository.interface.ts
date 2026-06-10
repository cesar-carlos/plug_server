export interface ClientRegistrationPollToken {
  readonly id: string;
  readonly clientId: string;
  readonly createdAt: Date;
}

export interface IClientRegistrationPollTokenRepository {
  save(token: ClientRegistrationPollToken): Promise<void>;
  findById(id: string): Promise<ClientRegistrationPollToken | null>;
  findByClientId(clientId: string): Promise<ClientRegistrationPollToken | null>;
  deleteByClientId(clientId: string): Promise<void>;
}
