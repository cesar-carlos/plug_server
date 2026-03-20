export interface RegisteredAgent {
  readonly agentId: string;
  readonly socketId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

class InMemoryAgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly agentIdBySocketId = new Map<string, string>();
  /**
   * Agent IDs ever registered in this process; retained after disconnect so REST can
   * distinguish "unknown id" vs "known but offline". Not pruned — unbounded if many ephemeral IDs.
   */
  private readonly knownAgentIds = new Set<string>();
  private readonly ownerByAgentId = new Map<string, string>();

  upsert(input: {
    readonly agentId: string;
    readonly socketId: string;
    readonly userId: string | null;
    readonly capabilities: Record<string, unknown>;
  }): { ok: true; agent: RegisteredAgent } | { ok: false; reason: "OWNED_BY_ANOTHER_USER" } {
    const ownerUserId = this.ownerByAgentId.get(input.agentId);
    if (
      typeof ownerUserId === "string" &&
      ownerUserId !== "" &&
      (!input.userId || input.userId !== ownerUserId)
    ) {
      return { ok: false, reason: "OWNED_BY_ANOTHER_USER" };
    }

    if (!ownerUserId && input.userId) {
      this.ownerByAgentId.set(input.agentId, input.userId);
    }

    const now = new Date().toISOString();
    const existing = this.agents.get(input.agentId);
    if (existing && existing.socketId !== input.socketId) {
      this.agentIdBySocketId.delete(existing.socketId);
    }

    const agent: RegisteredAgent = {
      agentId: input.agentId,
      socketId: input.socketId,
      userId: input.userId,
      capabilities: input.capabilities,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
    };

    this.knownAgentIds.add(input.agentId);
    this.agents.set(input.agentId, agent);
    this.agentIdBySocketId.set(input.socketId, input.agentId);
    return { ok: true, agent };
  }

  touch(agentId: string): RegisteredAgent | null {
    const existing = this.agents.get(agentId);
    if (!existing) {
      return null;
    }

    const updated: RegisteredAgent = {
      ...existing,
      lastSeenAt: new Date().toISOString(),
    };
    this.agents.set(agentId, updated);
    return updated;
  }

  removeBySocketId(socketId: string): RegisteredAgent | null {
    const agentId = this.agentIdBySocketId.get(socketId);
    if (!agentId) {
      return null;
    }

    this.agentIdBySocketId.delete(socketId);
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    this.agents.delete(agentId);
    return agent;
  }

  listAll(): readonly RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  findByAgentId(agentId: string): RegisteredAgent | null {
    return this.agents.get(agentId) ?? null;
  }

  hasKnownAgentId(agentId: string): boolean {
    return this.knownAgentIds.has(agentId);
  }

  clear(): void {
    this.agents.clear();
    this.agentIdBySocketId.clear();
    this.knownAgentIds.clear();
    this.ownerByAgentId.clear();
  }
}

export const agentRegistry = new InMemoryAgentRegistry();
