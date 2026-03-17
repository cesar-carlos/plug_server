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
  private readonly knownAgentIds = new Set<string>();

  upsert(input: {
    readonly agentId: string;
    readonly socketId: string;
    readonly userId: string | null;
    readonly capabilities: Record<string, unknown>;
  }): RegisteredAgent {
    const now = new Date().toISOString();
    const existing = this.agents.get(input.agentId);

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
    return agent;
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
    for (const [agentId, agent] of this.agents.entries()) {
      if (agent.socketId === socketId) {
        this.agents.delete(agentId);
        return agent;
      }
    }

    return null;
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
    this.knownAgentIds.clear();
  }
}

export const agentRegistry = new InMemoryAgentRegistry();
