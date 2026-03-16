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
}

export const agentRegistry = new InMemoryAgentRegistry();
