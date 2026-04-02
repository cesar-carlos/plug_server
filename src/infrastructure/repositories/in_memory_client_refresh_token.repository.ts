import type { ClientRefreshToken } from "../../domain/entities/client_refresh_token.entity";
import type {
  ConsumeClientRefreshTokenStatus,
  IClientRefreshTokenRepository,
} from "../../domain/repositories/client_refresh_token.repository.interface";

export class InMemoryClientRefreshTokenRepository implements IClientRefreshTokenRepository {
  private readonly store = new Map<string, ClientRefreshToken>();

  async findById(id: string): Promise<ClientRefreshToken | null> {
    return this.store.get(id) ?? null;
  }

  async save(token: ClientRefreshToken): Promise<void> {
    this.store.set(token.id, token);
  }

  async revoke(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.store.set(id, token.revoke());
    }
  }

  async revokeAllForClient(clientId: string): Promise<void> {
    for (const [id, token] of this.store.entries()) {
      if (token.clientId === clientId && !token.isRevoked) {
        this.store.set(id, token.revoke());
      }
    }
  }

  async consume(id: string, clientId: string, now: Date): Promise<ConsumeClientRefreshTokenStatus> {
    const token = this.store.get(id);
    if (!token) {
      return "not_found";
    }
    if (token.clientId !== clientId) {
      return "client_mismatch";
    }
    if (token.isRevoked) {
      return "revoked";
    }
    if (token.expiresAt <= now) {
      return "expired";
    }
    this.store.set(id, token.revoke());
    return "consumed";
  }
}
