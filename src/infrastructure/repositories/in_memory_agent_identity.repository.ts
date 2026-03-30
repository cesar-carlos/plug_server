import type {
  BindAgentIdentityStatus,
  IAgentIdentityRepository,
} from "../../domain/repositories/agent_identity.repository.interface";

interface IdentityRecord {
  userId: string;
  createdAt: Date;
}

export class InMemoryAgentIdentityRepository implements IAgentIdentityRepository {
  private readonly ownerByAgentId = new Map<string, IdentityRecord>();

  async findOwnerUserId(agentId: string): Promise<string | null> {
    return this.ownerByAgentId.get(agentId)?.userId ?? null;
  }

  async bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus> {
    const existing = this.ownerByAgentId.get(agentId);
    if (!existing) {
      this.ownerByAgentId.set(agentId, { userId, createdAt: new Date() });
      return "bound";
    }

    if (existing.userId === userId) {
      return "already_bound_to_user";
    }

    return "bound_to_other_user";
  }

  async hasAccess(userId: string, agentId: string): Promise<boolean> {
    return this.ownerByAgentId.get(agentId)?.userId === userId;
  }

  async listAgentIdsByUserId(userId: string): Promise<string[]> {
    const result: Array<{ agentId: string; createdAt: Date }> = [];
    for (const [agentId, record] of this.ownerByAgentId.entries()) {
      if (record.userId === userId) {
        result.push({ agentId, createdAt: record.createdAt });
      }
    }
    result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return result.map((r) => r.agentId);
  }

  async addAgentIds(userId: string, agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) {
      if (!this.ownerByAgentId.has(agentId)) {
        this.ownerByAgentId.set(agentId, { userId, createdAt: new Date() });
      }
    }
  }

  async removeAgentIds(userId: string, agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) {
      const record = this.ownerByAgentId.get(agentId);
      if (record?.userId === userId) {
        this.ownerByAgentId.delete(agentId);
      }
    }
  }

  async replaceAgentIds(userId: string, agentIds: string[]): Promise<void> {
    for (const [agentId, record] of this.ownerByAgentId.entries()) {
      if (record.userId === userId) {
        this.ownerByAgentId.delete(agentId);
      }
    }
    for (const agentId of agentIds) {
      this.ownerByAgentId.set(agentId, { userId, createdAt: new Date() });
    }
  }

  clear(): void {
    this.ownerByAgentId.clear();
  }
}
