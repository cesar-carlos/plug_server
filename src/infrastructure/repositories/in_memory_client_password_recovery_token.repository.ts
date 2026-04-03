import type {
  ClientPasswordRecoveryToken,
  IClientPasswordRecoveryTokenRepository,
} from "../../domain/repositories/client_password_recovery_token.repository.interface";

export class InMemoryClientPasswordRecoveryTokenRepository
  implements IClientPasswordRecoveryTokenRepository
{
  private readonly store = new Map<string, ClientPasswordRecoveryToken>();
  private readonly tokenIdByClientId = new Map<string, string>();

  async save(token: ClientPasswordRecoveryToken): Promise<void> {
    const existingTokenId = this.tokenIdByClientId.get(token.clientId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(token.id, token);
    this.tokenIdByClientId.set(token.clientId, token.id);
  }

  async findById(id: string): Promise<ClientPasswordRecoveryToken | null> {
    return this.store.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.tokenIdByClientId.delete(token.clientId);
    }
    this.store.delete(id);
  }

  async deleteByClientId(clientId: string): Promise<void> {
    const tokenId = this.tokenIdByClientId.get(clientId);
    if (!tokenId) {
      return;
    }
    this.tokenIdByClientId.delete(clientId);
    this.store.delete(tokenId);
  }
}
