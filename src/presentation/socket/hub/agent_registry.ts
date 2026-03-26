import { env } from "../../../shared/config/env";

export interface RegisteredAgent {
  readonly agentId: string;
  readonly socketId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

type ProtocolReadyMode = "grace" | "explicit_ack";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readBoolean = (value: unknown): boolean | null => {
  return typeof value === "boolean" ? value : null;
};

const readPositiveInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.floor(value));
};

const pickPositiveInteger = (source: Record<string, unknown> | null, keys: readonly string[]): number | null => {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = readPositiveInteger(source[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
};

const resolveProtocolReadyMode = (capabilities: Record<string, unknown>): ProtocolReadyMode => {
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
  const explicitReady =
    readBoolean(extensions?.protocolReadyAck) ??
    readBoolean(extensions?.protocol_ready_ack) ??
    readBoolean(capabilities.protocolReadyAck) ??
    readBoolean(capabilities.protocol_ready_ack);

  return explicitReady === true ? "explicit_ack" : "grace";
};

const resolveStreamPullWindowPolicy = (
  capabilities: Record<string, unknown>,
): { readonly recommendedWindow: number | null; readonly maxWindow: number | null } => {
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
  const limits = isRecord(capabilities.limits) ? capabilities.limits : null;

  const recommendedWindow =
    pickPositiveInteger(extensions, [
      "recommendedStreamPullWindowSize",
      "recommended_stream_pull_window_size",
      "streamPullWindowSize",
      "stream_pull_window_size",
    ]) ??
    pickPositiveInteger(limits, [
      "recommendedStreamPullWindowSize",
      "recommended_stream_pull_window_size",
      "streamPullWindowSize",
      "stream_pull_window_size",
    ]);

  const maxWindow =
    pickPositiveInteger(extensions, ["maxStreamPullWindowSize", "max_stream_pull_window_size"]) ??
    pickPositiveInteger(limits, ["maxStreamPullWindowSize", "max_stream_pull_window_size"]);

  return { recommendedWindow, maxWindow };
};

class InMemoryAgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly agentIdBySocketId = new Map<string, string>();
  private readonly readyAtByAgentId = new Map<string, number>();
  private readonly readyTimerByAgentId = new Map<string, NodeJS.Timeout>();
  private readonly protocolReadyModeByAgentId = new Map<string, ProtocolReadyMode>();
  /**
   * Agent IDs ever registered in this process; retained after disconnect so REST can
   * distinguish "unknown id" vs "known but offline". When `SOCKET_AGENT_KNOWN_IDS_MAX` > 0,
   * prunes disconnected IDs if the set grows beyond the cap.
   */
  private readonly knownAgentIds = new Set<string>();
  private readonly ownerByAgentId = new Map<string, string>();

  private pruneKnownAgentIdsIfOverCap(): void {
    const max = env.socketAgentKnownIdsMax;
    if (max <= 0 || this.knownAgentIds.size <= max) {
      return;
    }

    const connected = new Set(this.agents.keys());
    for (const id of [...this.knownAgentIds]) {
      if (this.knownAgentIds.size <= max) {
        break;
      }
      if (!connected.has(id)) {
        this.knownAgentIds.delete(id);
      }
    }
  }

  private clearReadyTimer(agentId: string): void {
    const timer = this.readyTimerByAgentId.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.readyTimerByAgentId.delete(agentId);
    }
  }

  private scheduleProtocolReady(agentId: string, capabilities: Record<string, unknown>): void {
    this.clearReadyTimer(agentId);
    const readyMode = resolveProtocolReadyMode(capabilities);
    this.protocolReadyModeByAgentId.set(agentId, readyMode);
    if (readyMode === "explicit_ack") {
      this.readyAtByAgentId.delete(agentId);
      return;
    }
    const graceMs = env.socketAgentProtocolReadyGraceMs;
    const readyAt = Date.now() + graceMs;
    this.readyAtByAgentId.set(agentId, readyAt);
    if (graceMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      this.readyTimerByAgentId.delete(agentId);
      this.readyAtByAgentId.set(agentId, Date.now());
    }, graceMs);
    timer.unref?.();
    this.readyTimerByAgentId.set(agentId, timer);
  }

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
    this.scheduleProtocolReady(input.agentId, input.capabilities);
    this.pruneKnownAgentIdsIfOverCap();
    return { ok: true, agent };
  }

  touch(agentId: string, options?: { readonly markProtocolReady?: boolean }): RegisteredAgent | null {
    const existing = this.agents.get(agentId);
    if (!existing) {
      return null;
    }

    const updated: RegisteredAgent = {
      ...existing,
      lastSeenAt: new Date().toISOString(),
    };
    this.agents.set(agentId, updated);
    if (options?.markProtocolReady) {
      this.clearReadyTimer(agentId);
      this.readyAtByAgentId.set(agentId, Date.now());
    }
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

    this.clearReadyTimer(agentId);
    this.readyAtByAgentId.delete(agentId);
    this.protocolReadyModeByAgentId.delete(agentId);
    this.agents.delete(agentId);
    return agent;
  }

  listAll(): readonly RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  findByAgentId(agentId: string): RegisteredAgent | null {
    return this.agents.get(agentId) ?? null;
  }

  findBySocketId(socketId: string): RegisteredAgent | null {
    const agentId = this.agentIdBySocketId.get(socketId);
    if (!agentId) {
      return null;
    }

    return this.agents.get(agentId) ?? null;
  }

  hasKnownAgentId(agentId: string): boolean {
    return this.knownAgentIds.has(agentId);
  }

  getProtocolReadiness(agentId: string): { readonly ready: boolean; readonly retryAfterMs: number } {
    if (!this.agents.has(agentId)) {
      return { ready: false, retryAfterMs: 0 };
    }
    const readyAt = this.readyAtByAgentId.get(agentId);
    if (readyAt === undefined) {
      const mode = this.protocolReadyModeByAgentId.get(agentId) ?? "grace";
      return {
        ready: false,
        retryAfterMs: mode === "explicit_ack" ? env.socketAgentProtocolReadyGraceMs : 0,
      };
    }
    const remaining = Math.max(0, readyAt - Date.now());
    return {
      ready: remaining <= 0,
      retryAfterMs: remaining,
    };
  }

  resolveStreamPullWindow(agentId: string, fallbackWindow: number, requestedWindow?: number): number {
    const baseWindow =
      typeof requestedWindow === "number" && Number.isFinite(requestedWindow) && requestedWindow > 0
        ? Math.max(1, Math.floor(requestedWindow))
        : Math.max(1, Math.floor(fallbackWindow));
    const agent = this.agents.get(agentId);
    if (!agent) {
      return baseWindow;
    }

    const { recommendedWindow, maxWindow } = resolveStreamPullWindowPolicy(agent.capabilities);
    const resolved = requestedWindow === undefined && recommendedWindow !== null ? recommendedWindow : baseWindow;

    return maxWindow !== null ? Math.max(1, Math.min(resolved, maxWindow)) : resolved;
  }

  clear(): void {
    for (const timer of this.readyTimerByAgentId.values()) {
      clearTimeout(timer);
    }
    this.agents.clear();
    this.agentIdBySocketId.clear();
    this.readyAtByAgentId.clear();
    this.readyTimerByAgentId.clear();
    this.protocolReadyModeByAgentId.clear();
    this.knownAgentIds.clear();
    this.ownerByAgentId.clear();
  }
}

export const agentRegistry = new InMemoryAgentRegistry();
