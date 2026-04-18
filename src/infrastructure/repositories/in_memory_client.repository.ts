import type { Client } from "../../domain/entities/client.entity";
import type {
  ClientActiveSnapshot,
  IClientRepository,
} from "../../domain/repositories/client.repository.interface";

export class InMemoryClientRepository implements IClientRepository {
  private readonly store = new Map<string, Client>();

  async findById(id: string): Promise<Client | null> {
    return this.store.get(id) ?? null;
  }

  async findActiveSnapshotById(id: string): Promise<ClientActiveSnapshot | null> {
    const client = this.store.get(id);
    if (!client) return null;
    return {
      id: client.id,
      status: client.status,
      credentialsUpdatedAt: client.credentialsUpdatedAt,
    };
  }

  async findByEmail(email: string): Promise<Client | null> {
    for (const client of this.store.values()) {
      if (client.email === email) {
        return client;
      }
    }
    return null;
  }

  async listByUserId(userId: string): Promise<Client[]> {
    return [...this.store.values()].filter((client) => client.userId === userId);
  }

  async save(client: Client): Promise<void> {
    this.store.set(client.id, client);
  }

  async deleteById(id: string): Promise<void> {
    this.store.delete(id);
  }
}
