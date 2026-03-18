import type {
  BindAgentIdentityStatus,
  IAgentIdentityRepository,
} from "../../domain/repositories/agent_identity.repository.interface";

export class InMemoryAgentIdentityRepository implements IAgentIdentityRepository {
  private readonly ownerByAgentId = new Map<string, string>();

  async findOwnerUserId(agentId: string): Promise<string | null> {
    return this.ownerByAgentId.get(agentId) ?? null;
  }

  async bindIfUnbound(agentId: string, userId: string): Promise<BindAgentIdentityStatus> {
    const existingOwner = this.ownerByAgentId.get(agentId);
    if (!existingOwner) {
      this.ownerByAgentId.set(agentId, userId);
      return "bound";
    }

    if (existingOwner === userId) {
      return "already_bound_to_user";
    }

    return "bound_to_other_user";
  }

  clear(): void {
    this.ownerByAgentId.clear();
  }
}
