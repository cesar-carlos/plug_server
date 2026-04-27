import { ClientAgentAccessRequest } from "../../domain/entities/client_agent_access_request.entity";
import type { ClientAgentAccessRequestStatus } from "../../domain/entities/client_agent_access_request.entity";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";

export class InMemoryClientAgentAccessRequestRepository implements IClientAgentAccessRequestRepository {
  private readonly store = new Map<string, ClientAgentAccessRequest>();

  async findById(id: string): Promise<ClientAgentAccessRequest | null> {
    return this.store.get(id) ?? null;
  }

  async findByClientAndAgent(
    clientId: string,
    agentId: string,
  ): Promise<ClientAgentAccessRequest | null> {
    for (const request of this.store.values()) {
      if (request.clientId === clientId && request.agentId === agentId) {
        return request;
      }
    }
    return null;
  }

  async findByClientAndAgents(
    clientId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, ClientAgentAccessRequest>> {
    const want = new Set(agentIds);
    const map = new Map<string, ClientAgentAccessRequest>();
    for (const request of this.store.values()) {
      if (request.clientId === clientId && want.has(request.agentId)) {
        map.set(request.agentId, request);
      }
    }
    return map;
  }

  async listByClientId(clientId: string): Promise<ClientAgentAccessRequest[]> {
    return [...this.store.values()]
      .filter((request) => request.clientId === clientId)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  }

  async listByOwnerUserId(ownerUserId: string): Promise<ClientAgentAccessRequest[]> {
    void ownerUserId;
    return [...this.store.values()].sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
    );
  }

  async listByClientPage(
    clientId: string,
    filter: {
      readonly status?: ClientAgentAccessRequestStatus;
      readonly search?: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<{ readonly items: ClientAgentAccessRequest[]; readonly total: number }> {
    let items = await this.listByClientId(clientId);
    if (filter.status !== undefined) {
      items = items.filter((request) => request.status === filter.status);
    }
    if (filter.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      items = items.filter((request) => request.agentId.toLowerCase().includes(query));
    }
    const total = items.length;
    const start = (filter.page - 1) * filter.pageSize;
    return { items: items.slice(start, start + filter.pageSize), total };
  }

  async listByOwnerPage(
    ownerUserId: string,
    filter: {
      readonly status?: ClientAgentAccessRequestStatus;
      readonly search?: string;
      readonly agentId?: string;
      readonly clientId?: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<{ readonly items: ClientAgentAccessRequest[]; readonly total: number }> {
    void ownerUserId;
    let items = [...this.store.values()].sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
    );
    if (filter.status !== undefined) {
      items = items.filter((request) => request.status === filter.status);
    }
    if (filter.agentId !== undefined) {
      items = items.filter((request) => request.agentId === filter.agentId);
    }
    if (filter.clientId !== undefined) {
      items = items.filter((request) => request.clientId === filter.clientId);
    }
    if (filter.search !== undefined && filter.search.trim() !== "") {
      const query = filter.search.trim().toLowerCase();
      items = items.filter(
        (request) =>
          request.agentId.toLowerCase().includes(query) ||
          request.clientId.toLowerCase().includes(query),
      );
    }
    const total = items.length;
    const start = (filter.page - 1) * filter.pageSize;
    return { items: items.slice(start, start + filter.pageSize), total };
  }

  async save(request: ClientAgentAccessRequest): Promise<void> {
    this.store.set(request.id, request);
  }

  async setStatus(
    requestId: string,
    status: Exclude<ClientAgentAccessRequestStatus, "pending">,
    options?: { decidedAt?: Date; reason?: string },
  ): Promise<void> {
    const existing = this.store.get(requestId);
    if (!existing) {
      return;
    }
    this.store.set(
      requestId,
      new ClientAgentAccessRequest({
        ...existing,
        status,
        retryCount: existing.retryCount,
        decidedAt: options?.decidedAt ?? new Date(),
        ...(options?.reason !== undefined ? { decisionReason: options.reason } : {}),
        updatedAt: new Date(),
      }),
    );
  }
}
