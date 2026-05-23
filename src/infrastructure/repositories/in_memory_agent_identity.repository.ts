import type {
  BindAgentIdentityStatus,
  IAgentIdentityRepository,
  UserAgentIdListPage,
  UserAgentListFilter,
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

  async findOwnerUserIdsByAgentIds(agentIds: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const agentId of new Set(agentIds)) {
      const userId = this.ownerByAgentId.get(agentId)?.userId;
      if (userId !== undefined) {
        map.set(agentId, userId);
      }
    }
    return map;
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
    return result.map((entry) => entry.agentId);
  }

  async listAgentIdsPageByUserId(
    userId: string,
    filter?: UserAgentListFilter,
  ): Promise<UserAgentIdListPage> {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, filter?.pageSize ?? 20));
    const result: Array<{ agentId: string; createdAt: Date }> = [];
    for (const [agentId, record] of this.ownerByAgentId.entries()) {
      if (record.userId === userId) {
        result.push({ agentId, createdAt: record.createdAt });
      }
    }
    result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const total = result.length;
    const start = (page - 1) * pageSize;
    return {
      agentIds: result.slice(start, start + pageSize).map((entry) => entry.agentId),
      total,
      page,
      pageSize,
    };
  }

  clear(): void {
    this.ownerByAgentId.clear();
  }
}
