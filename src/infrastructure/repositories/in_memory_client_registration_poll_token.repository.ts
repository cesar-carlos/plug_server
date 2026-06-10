import type {
  ClientRegistrationPollToken,
  IClientRegistrationPollTokenRepository,
} from "../../domain/repositories/client_registration_poll_token.repository.interface";

export class InMemoryClientRegistrationPollTokenRepository implements IClientRegistrationPollTokenRepository {
  private readonly store = new Map<string, ClientRegistrationPollToken>();
  private readonly tokenIdByClientId = new Map<string, string>();

  async save(token: ClientRegistrationPollToken): Promise<void> {
    const existingTokenId = this.tokenIdByClientId.get(token.clientId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async findById(id: string): Promise<ClientRegistrationPollToken | null> {
    return this.store.get(id) ?? null;
  }

  async findByClientId(clientId: string): Promise<ClientRegistrationPollToken | null> {
    const tokenId = this.tokenIdByClientId.get(clientId);
    return tokenId ? (this.store.get(tokenId) ?? null) : null;
  }

  async deleteByClientId(clientId: string): Promise<void> {
    const tokenId = this.tokenIdByClientId.get(clientId);
    if (tokenId) {
      this.store.delete(tokenId);
      this.tokenIdByClientId.delete(clientId);
    }
  }
}
