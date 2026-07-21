import type { AgentSessionPolicy } from "../../../../shared/constants/agent_session_policy";
import {
  clearAgentHealthPiggybackState,
  shouldSkipScheduledAgentHealthPoll,
} from "../../../../application/services/agent_health_piggyback.service";
import { env } from "../../../../shared/config/env";
import {
  HUB_MAX_BATCH_SIZE,
  HUB_MAX_CONCURRENT_STREAMS,
  HUB_MAX_ROWS,
} from "../../../../shared/constants/agent_transport_contract";

export interface RegisteredAgent {
  readonly agentId: string;
  readonly socketId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

interface InternalRegisteredAgent {
  readonly agentId: string;
  readonly socketId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAtMs: number;
  /** Pre-computed ISO string for `connectedAt` — never changes after creation. */
  readonly connectedAtIso: string;
  lastSeenAtMs: number;
  /**
   * Dispatch limits resolved from `capabilities` at registration time.
   * Capabilities are immutable after register, so this can be read directly
   * instead of re-parsing on every dispatch (hot path for rpc:request).
   */
  readonly dispatchPolicy: ReturnType<typeof resolveDispatchPolicy>;
  /**
   * Stream-pull window hints resolved from `capabilities` at registration time.
   * Used by `resolveStreamPullWindow` to skip re-parsing on each pull.
   */
  readonly streamPullWindowPolicy: ReturnType<typeof resolveStreamPullWindowPolicy>;
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

const pickPositiveInteger = (
  source: Record<string, unknown> | null,
  keys: readonly string[],
): number | null => {
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

const toCompressionSet = (value: unknown): ReadonlySet<string> => {
  if (!Array.isArray(value)) {
    return new Set<string>();
  }
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim().toLowerCase();
    if (normalized !== "") {
      out.add(normalized);
    }
  }
  return out;
};

const resolveDispatchPolicy = (
  capabilities: Record<string, unknown>,
): {
  readonly maxRows: number;
  readonly maxBatchSize: number;
  readonly maxConcurrentStreams: number;
  readonly allowsGzip: boolean;
  readonly allowsNoneCompression: boolean;
} => {
  const limits = isRecord(capabilities.limits) ? capabilities.limits : null;
  const compressions = toCompressionSet(capabilities.compressions);
  const advertisedMaxRows = pickPositiveInteger(limits, ["max_rows", "maxRows"]);
  const advertisedMaxBatch = pickPositiveInteger(limits, ["max_batch_size", "maxBatchSize"]);
  const advertisedMaxConcurrentStreams = pickPositiveInteger(limits, [
    "max_concurrent_streams",
    "maxConcurrentStreams",
  ]);

  const maxRows =
    advertisedMaxRows !== null
      ? Math.max(1, Math.min(HUB_MAX_ROWS, advertisedMaxRows))
      : HUB_MAX_ROWS;
  const maxBatchSize =
    advertisedMaxBatch !== null
      ? Math.max(1, Math.min(HUB_MAX_BATCH_SIZE, advertisedMaxBatch))
      : HUB_MAX_BATCH_SIZE;
  const maxConcurrentStreams =
    advertisedMaxConcurrentStreams !== null
      ? Math.max(1, Math.min(HUB_MAX_CONCURRENT_STREAMS, advertisedMaxConcurrentStreams))
      : HUB_MAX_CONCURRENT_STREAMS;

  return {
    maxRows,
    maxBatchSize,
    maxConcurrentStreams,
    allowsGzip: compressions.size === 0 ? true : compressions.has("gzip"),
    allowsNoneCompression: compressions.size === 0 ? true : compressions.has("none"),
  };
};

class InMemoryAgentRegistry {
  private readonly agents = new Map<string, InternalRegisteredAgent>();
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

  private toPublic(internal: InternalRegisteredAgent): RegisteredAgent {
    return {
      agentId: internal.agentId,
      socketId: internal.socketId,
      userId: internal.userId,
      capabilities: internal.capabilities,
      connectedAt: internal.connectedAtIso,
      lastSeenAt: new Date(internal.lastSeenAtMs).toISOString(),
    };
  }

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

  /**
   * Pure session-policy peek: returns true when `reject_active` would deny
   * registration because another connected socket already owns `agentId`.
   * Used before rate-limit consumption so reconnect races do not burn quota.
   */
  wouldRejectActiveSession(input: {
    readonly agentId: string;
    readonly socketId: string;
    readonly policy: AgentSessionPolicy;
    readonly isPeerConnected: (socketId: string) => boolean;
  }): boolean {
    if (input.policy !== "reject_active") {
      return false;
    }
    const existing = this.agents.get(input.agentId);
    if (!existing || existing.socketId === input.socketId) {
      return false;
    }
    return input.isPeerConnected(existing.socketId);
  }

  /**
   * Atomically registers or rejects an agent session (same event-loop turn; no await inside).
   */
  registerAgentSession(input: {
    readonly agentId: string;
    readonly socketId: string;
    readonly userId: string | null;
    readonly capabilities: Record<string, unknown>;
    readonly policy: AgentSessionPolicy;
    readonly isPeerConnected: (socketId: string) => boolean;
  }):
    | { ok: true; agent: RegisteredAgent; replacedSocketId?: string }
    | { ok: false; reason: "OWNED_BY_ANOTHER_USER" | "SESSION_ACTIVE" } {
    const nowMs = Date.now();
    const existing = this.agents.get(input.agentId);
    if (
      existing &&
      existing.userId !== null &&
      input.userId !== null &&
      existing.userId !== input.userId
    ) {
      return { ok: false, reason: "OWNED_BY_ANOTHER_USER" };
    }

    let replacedSocketId: string | undefined;
    const previousAgentIdForSocket = this.agentIdBySocketId.get(input.socketId);
    if (previousAgentIdForSocket && previousAgentIdForSocket !== input.agentId) {
      this.clearReadyTimer(previousAgentIdForSocket);
      this.readyAtByAgentId.delete(previousAgentIdForSocket);
      this.protocolReadyModeByAgentId.delete(previousAgentIdForSocket);
      this.agents.delete(previousAgentIdForSocket);
    }

    if (existing && existing.socketId !== input.socketId) {
      const peerAlive = input.isPeerConnected(existing.socketId);
      if (peerAlive) {
        if (input.policy === "reject_active") {
          return { ok: false, reason: "SESSION_ACTIVE" };
        }
        this.agentIdBySocketId.delete(existing.socketId);
        if (input.policy === "takeover_disconnect_previous") {
          replacedSocketId = existing.socketId;
        }
      } else {
        this.agentIdBySocketId.delete(existing.socketId);
      }
    }

    const connectedAtMs = existing?.socketId === input.socketId ? existing.connectedAtMs : nowMs;
    const agent: InternalRegisteredAgent = {
      agentId: input.agentId,
      socketId: input.socketId,
      userId: input.userId,
      capabilities: input.capabilities,
      connectedAtMs,
      connectedAtIso:
        existing?.socketId === input.socketId
          ? existing.connectedAtIso
          : new Date(connectedAtMs).toISOString(),
      lastSeenAtMs: nowMs,
      dispatchPolicy: resolveDispatchPolicy(input.capabilities),
      streamPullWindowPolicy: resolveStreamPullWindowPolicy(input.capabilities),
    };

    this.knownAgentIds.add(input.agentId);
    this.agents.set(input.agentId, agent);
    this.agentIdBySocketId.set(input.socketId, input.agentId);
    this.scheduleProtocolReady(input.agentId, input.capabilities);
    this.pruneKnownAgentIdsIfOverCap();
    return {
      ok: true,
      agent: this.toPublic(agent),
      ...(replacedSocketId !== undefined ? { replacedSocketId } : {}),
    };
  }

  upsert(input: {
    readonly agentId: string;
    readonly socketId: string;
    readonly userId: string | null;
    readonly capabilities: Record<string, unknown>;
  }): { ok: true; agent: RegisteredAgent } | { ok: false; reason: "OWNED_BY_ANOTHER_USER" } {
    const result = this.registerAgentSession({
      ...input,
      policy: "legacy_silent_takeover",
      isPeerConnected: () => true,
    });
    if (!result.ok) {
      return { ok: false, reason: "OWNED_BY_ANOTHER_USER" };
    }
    return { ok: true, agent: result.agent };
  }

  touch(
    agentId: string,
    options?: { readonly markProtocolReady?: boolean; readonly socketId?: string },
  ): RegisteredAgent | null {
    const existing = this.agents.get(agentId);
    if (!existing) {
      return null;
    }
    if (options?.socketId !== undefined && existing.socketId !== options.socketId) {
      return null;
    }

    existing.lastSeenAtMs = Date.now();
    this.agents.set(agentId, existing);
    if (options?.markProtocolReady) {
      this.clearReadyTimer(agentId);
      this.readyAtByAgentId.set(agentId, Date.now());
    }
    return this.toPublic(existing);
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
    clearAgentHealthPiggybackState(agentId);
    return this.toPublic(agent);
  }

  listAll(): readonly RegisteredAgent[] {
    return Array.from(this.agents.values()).map((internal) => this.toPublic(internal));
  }

  listIdle(idleTimeoutMs: number): readonly RegisteredAgent[] {
    const timeoutMs = Math.max(1, Math.floor(idleTimeoutMs));
    const nowMs = Date.now();
    const idle: RegisteredAgent[] = [];

    for (const internal of this.agents.values()) {
      if (nowMs - internal.lastSeenAtMs >= timeoutMs) {
        idle.push(this.toPublic(internal));
      }
    }

    return idle;
  }

  findByAgentId(agentId: string): RegisteredAgent | null {
    const internal = this.agents.get(agentId);
    return internal ? this.toPublic(internal) : null;
  }

  shouldSkipScheduledHealthPoll(agentId: string, nowMs?: number): boolean {
    return shouldSkipScheduledAgentHealthPoll(agentId, nowMs);
  }

  findBySocketId(socketId: string): RegisteredAgent | null {
    const agentId = this.agentIdBySocketId.get(socketId);
    if (!agentId) {
      return null;
    }

    const internal = this.agents.get(agentId);
    return internal ? this.toPublic(internal) : null;
  }

  hasKnownAgentId(agentId: string): boolean {
    return this.knownAgentIds.has(agentId);
  }

  getProtocolReadiness(agentId: string): {
    readonly ready: boolean;
    readonly retryAfterMs: number;
  } {
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

  resolveStreamPullWindow(
    agentId: string,
    fallbackWindow: number,
    requestedWindow?: number,
  ): number {
    const hubMaxWindow = Math.max(1, Math.floor(env.socketRestStreamPullMaxWindowSize));
    const baseWindow =
      typeof requestedWindow === "number" && Number.isFinite(requestedWindow) && requestedWindow > 0
        ? Math.max(1, Math.floor(requestedWindow))
        : Math.max(1, Math.floor(fallbackWindow));
    const agent = this.agents.get(agentId);
    if (!agent) {
      return Math.min(baseWindow, hubMaxWindow);
    }

    const { recommendedWindow, maxWindow } = agent.streamPullWindowPolicy;
    const resolved =
      requestedWindow === undefined && recommendedWindow !== null ? recommendedWindow : baseWindow;
    const maxAllowedWindow = maxWindow !== null ? Math.min(maxWindow, hubMaxWindow) : hubMaxWindow;

    return Math.max(1, Math.min(resolved, maxAllowedWindow));
  }

  resolveEffectiveDispatchPolicy(agentId: string): {
    readonly maxRows: number;
    readonly maxBatchSize: number;
    readonly maxConcurrentStreams: number;
    readonly allowsGzip: boolean;
    readonly allowsNoneCompression: boolean;
  } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return {
        maxRows: HUB_MAX_ROWS,
        maxBatchSize: HUB_MAX_BATCH_SIZE,
        maxConcurrentStreams: HUB_MAX_CONCURRENT_STREAMS,
        allowsGzip: true,
        allowsNoneCompression: true,
      };
    }
    return agent.dispatchPolicy;
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
  }
}

export const agentRegistry = new InMemoryAgentRegistry();
