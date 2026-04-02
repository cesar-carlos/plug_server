import {
  ClientAgentAccessRequest,
} from "../../domain/entities/client_agent_access_request.entity";
import type { ClientAgentAccessRequestStatus } from "../../domain/entities/client_agent_access_request.entity";
import type { IClientAgentAccessRequestRepository } from "../../domain/repositories/client_agent_access_request.repository.interface";

export class InMemoryClientAgentAccessRequestRepository
  implements IClientAgentAccessRequestRepository
{
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

  async listByClientId(clientId: string): Promise<ClientAgentAccessRequest[]> {
    return [...this.store.values()]
      .filter((request) => request.clientId === clientId)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  }

  async listByOwnerUserId(ownerUserId: string): Promise<ClientAgentAccessRequest[]> {
    void ownerUserId;
    return [...this.store.values()]
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
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
      decidedAt: options?.decidedAt ?? new Date(),
      ...(options?.reason !== undefined ? { decisionReason: options.reason } : {}),
      updatedAt: new Date(),
      }),
    );
  }
}
