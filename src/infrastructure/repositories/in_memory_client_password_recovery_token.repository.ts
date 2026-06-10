import type {
  ClientPasswordRecoveryToken,
  IClientPasswordRecoveryTokenRepository,
} from "../../domain/repositories/client_password_recovery_token.repository.interface";
import { hashRegistrationToken } from "../../shared/utils/registration_token_hash";

export class InMemoryClientPasswordRecoveryTokenRepository implements IClientPasswordRecoveryTokenRepository {
  private readonly store = new Map<string, ClientPasswordRecoveryToken>();
  private readonly tokenIdByClientId = new Map<string, string>();

  async save(token: ClientPasswordRecoveryToken): Promise<void> {
    const stored: ClientPasswordRecoveryToken = {
      ...token,
      id: hashRegistrationToken(token.id),
    };
    const existingTokenId = this.tokenIdByClientId.get(token.clientId);
    if (existingTokenId) {
      this.store.delete(existingTokenId);
    }
    this.store.set(stored.id, stored);
    this.tokenIdByClientId.set(token.clientId, stored.id);
  }

  async findById(id: string): Promise<ClientPasswordRecoveryToken | null> {
    const hashedId = hashRegistrationToken(id);
    return this.store.get(hashedId) ?? this.store.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    const hashedId = hashRegistrationToken(id);
    const token = this.store.get(hashedId) ?? this.store.get(id);
    if (token) {
      this.tokenIdByClientId.delete(token.clientId);
      this.store.delete(token.id);
      if (token.id !== hashedId) {
        this.store.delete(hashedId);
      }
      if (token.id !== id) {
        this.store.delete(id);
      }
    }
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
