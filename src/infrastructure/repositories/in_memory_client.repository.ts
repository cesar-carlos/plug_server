import type { Client } from "../../domain/entities/client.entity";
import type {
  ClientActiveSnapshot,
  IClientRepository,
  ManagedClientListFilter,
  ManagedClientListPage,
} from "../../domain/repositories/client.repository.interface";

export class InMemoryClientRepository implements IClientRepository {
  private readonly store = new Map<string, Client>();

  async findById(id: string): Promise<Client | null> {
    return this.store.get(id) ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<Client[]> {
    const out: Client[] = [];
    for (const id of new Set(ids)) {
      const client = this.store.get(id);
      if (client) {
        out.push(client);
      }
    }
    return out;
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
    const needle = email.trim().toLowerCase();
    if (needle === "") {
      return null;
    }
    for (const client of this.store.values()) {
      if (client.email.toLowerCase() === needle) {
        return client;
      }
    }
    return null;
  }

  async listByUserId(userId: string): Promise<Client[]> {
    return [...this.store.values()].filter((client) => client.userId === userId);
  }

  async listByUserIdPage(
    userId: string,
    filter?: ManagedClientListFilter,
  ): Promise<ManagedClientListPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, filter?.pageSize ?? 20));
    let clients = [...this.store.values()].filter((client) => client.userId === userId);

    if (filter?.status !== undefined) {
      clients = clients.filter((client) => client.status === filter.status);
    }
    if (filter?.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      clients = clients.filter(
        (client) =>
          client.email.toLowerCase().includes(query) ||
          client.name.toLowerCase().includes(query) ||
          client.lastName.toLowerCase().includes(query),
      );
    }

    clients.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const total = clients.length;
    const start = (page - 1) * pageSize;
    return {
      items: clients.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  async findActiveIdsByIds(ids: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const client = this.store.get(id);
      if (client?.status === "active") {
        out.push(id);
      }
    }
    return out;
  }

  async save(client: Client): Promise<void> {
    this.store.set(client.id, client);
  }

  async deleteById(id: string): Promise<void> {
    this.store.delete(id);
  }
}
