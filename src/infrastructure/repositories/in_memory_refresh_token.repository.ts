import type { RefreshToken } from "../../domain/entities/refresh_token.entity";
import type { IRefreshTokenRepository } from "../../domain/repositories/refresh_token.repository.interface";

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

  clear(): void {
    this.store.clear();
  }
}
