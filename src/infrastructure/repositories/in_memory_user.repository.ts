import type { User } from "../../domain/entities/user.entity";
import type { IUserRepository } from "../../domain/repositories/user.repository.interface";

export class InMemoryUserRepository implements IUserRepository {
  private readonly store = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    return this.store.get(id) ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<User[]> {
    const out: User[] = [];
    for (const id of new Set(ids)) {
      const user = this.store.get(id);
      if (user) {
        out.push(user);
      }
    }
    return out;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.store.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async findByCelular(celular: string): Promise<User | null> {
    for (const user of this.store.values()) {
      if (user.celular === celular) return user;
    }
    return null;
  }

  async save(user: User): Promise<void> {
    this.store.set(user.id, user);
  }

  clear(): void {
    this.store.clear();
  }
}
