import type { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type {
  ConsumeRefreshTokenStatus,
  IRefreshTokenRepository,
} from "../../domain/repositories/refresh_token.repository.interface";

export class InMemoryRefreshTokenRepository implements IRefreshTokenRepository {
  private readonly store = new Map<string, RefreshToken>();

  async findById(id: string): Promise<RefreshToken | null> {
    return this.store.get(id) ?? null;
  }

  async save(token: RefreshToken): Promise<void> {
    this.store.set(token.id, token);
  }

  async revoke(id: string): Promise<void> {
    const token = this.store.get(id);
    if (token) {
      this.store.set(id, token.revoke());
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const [id, token] of this.store.entries()) {
      if (token.userId === userId && !token.isRevoked) {
        this.store.set(id, token.revoke());
      }
    }
  }

  async consume(id: string, userId: string, now: Date): Promise<ConsumeRefreshTokenStatus> {
    const token = this.store.get(id);
    if (!token) {
      return "not_found";
    }

    if (token.userId !== userId) {
      return "user_mismatch";
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

  clear(): void {
    this.store.clear();
  }
}
