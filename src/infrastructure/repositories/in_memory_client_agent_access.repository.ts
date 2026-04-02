import type { IClientAgentAccessRepository } from "../../domain/repositories/client_agent_access.repository.interface";

export class InMemoryClientAgentAccessRepository implements IClientAgentAccessRepository {
  private readonly accessByClient = new Map<string, Set<string>>();

  async hasAccess(clientId: string, agentId: string): Promise<boolean> {
    return this.accessByClient.get(clientId)?.has(agentId) ?? false;
  }

  async listAgentIdsByClientId(clientId: string): Promise<string[]> {
    return [...(this.accessByClient.get(clientId) ?? new Set<string>())];
  }

  async listByAgentId(
    agentId: string,
  ): Promise<Array<{ clientId: string; agentId: string; approvedAt: Date }>> {
    const rows: Array<{ clientId: string; agentId: string; approvedAt: Date }> = [];
    for (const [clientId, agents] of this.accessByClient.entries()) {
      if (agents.has(agentId)) {
        rows.push({ clientId, agentId, approvedAt: new Date(0) });
      }
    }
    return rows;
  }

  async addAccess(clientId: string, agentId: string): Promise<void> {
    const current = this.accessByClient.get(clientId) ?? new Set<string>();
    current.add(agentId);
    this.accessByClient.set(clientId, current);
  }

  async removeAccess(clientId: string, agentId: string): Promise<void> {
    const current = this.accessByClient.get(clientId);
    if (!current) {
      return;
    }
    current.delete(agentId);
    this.accessByClient.set(clientId, current);
  }

  async removeAgentIds(clientId: string, agentIds: string[]): Promise<void> {
    const current = this.accessByClient.get(clientId);
    if (!current) {
      return;
    }
    for (const agentId of agentIds) {
      current.delete(agentId);
    }
    this.accessByClient.set(clientId, current);
  }
}
