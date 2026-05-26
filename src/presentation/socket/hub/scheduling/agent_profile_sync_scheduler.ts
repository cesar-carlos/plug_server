import { AppError } from "../../../../shared/errors/app_error";
import type {
  AgentRegisterProfileSnapshot,
  SyncAgentRegisterSnapshotInput,
} from "../../../../application/services/agent_profile_sync.service";

export interface AgentProfileSyncSchedulerInput {
  readonly agentId: string;
  readonly userId: string | null;
  readonly snapshot?: AgentRegisterProfileSnapshot;
}

export interface AgentProfileSyncSchedulerMetrics {
  profileSyncDedupedInFlightTotal: number;
  profileSyncSkippedRecentDuplicateTotal: number;
  profileSyncSkippedStaleSessionTotal: number;
  profileSyncFailedLogSuppressedTotal: number;
}

export interface AgentProfileSyncSchedulerLogger {
  info(event: string, payload: Record<string, unknown>): void;
  warn(event: string, payload: Record<string, unknown>): void;
}

export interface AgentProfileSyncSchedulerOptions {
  readonly recentTtlMs?: number;
  readonly recentMaxEntries?: number;
  readonly failedLogTtlMs?: number;
  readonly failedLogMaxEntries?: number;
  readonly maxAttempts?: number;
  readonly fallbackTimeoutMs?: number;
}

interface AgentProfileSyncSchedulerDependencies {
  readonly syncFromRegisterSnapshot: (input: SyncAgentRegisterSnapshotInput) => Promise<unknown>;
  readonly syncFromConnectedAgent: (input: {
    readonly agentId: string;
    readonly userId?: string;
    readonly timeoutMs: number;
  }) => Promise<unknown>;
  readonly acquireSlot: () => Promise<() => void>;
  readonly metrics: AgentProfileSyncSchedulerMetrics;
  readonly logger: AgentProfileSyncSchedulerLogger;
  readonly now?: () => number;
  readonly options?: AgentProfileSyncSchedulerOptions;
}

interface RecentProfileSync {
  readonly fingerprint: string;
  readonly expiresAtMs: number;
}

interface RateLimitedFailureLog {
  readonly expiresAtMs: number;
  suppressedCount: number;
}

export const defaultAgentProfileSyncRecentTtlMs = 30_000;
export const defaultAgentProfileSyncRecentMaxEntries = 5_000;
export const defaultAgentProfileSyncFailedLogTtlMs = 30_000;
export const defaultAgentProfileSyncFailedLogMaxEntries = 5_000;
export const defaultAgentProfileSyncMaxAttempts = 4;
export const defaultAgentProfileSyncFallbackTimeoutMs = 10_000;

export class AgentProfileSyncScheduler {
  constructor(dependencies: AgentProfileSyncSchedulerDependencies) {
    this.syncFromRegisterSnapshot = dependencies.syncFromRegisterSnapshot;
    this.syncFromConnectedAgent = dependencies.syncFromConnectedAgent;
    this.acquireSlot = dependencies.acquireSlot;
    this.metrics = dependencies.metrics;
    this.logger = dependencies.logger;
    this.now = dependencies.now ?? Date.now;

    const options = dependencies.options ?? {};
    this.recentTtlMs = options.recentTtlMs ?? defaultAgentProfileSyncRecentTtlMs;
    this.recentMaxEntries = options.recentMaxEntries ?? defaultAgentProfileSyncRecentMaxEntries;
    this.failedLogTtlMs = options.failedLogTtlMs ?? defaultAgentProfileSyncFailedLogTtlMs;
    this.failedLogMaxEntries =
      options.failedLogMaxEntries ?? defaultAgentProfileSyncFailedLogMaxEntries;
    this.maxAttempts = options.maxAttempts ?? defaultAgentProfileSyncMaxAttempts;
    this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? defaultAgentProfileSyncFallbackTimeoutMs;
  }

  private readonly syncFromRegisterSnapshot: (
    input: SyncAgentRegisterSnapshotInput,
  ) => Promise<unknown>;
  private readonly syncFromConnectedAgent: (input: {
    readonly agentId: string;
    readonly userId?: string;
    readonly timeoutMs: number;
  }) => Promise<unknown>;
  private readonly acquireSlot: () => Promise<() => void>;
  private readonly metrics: AgentProfileSyncSchedulerMetrics;
  private readonly logger: AgentProfileSyncSchedulerLogger;
  private readonly now: () => number;
  private readonly recentTtlMs: number;
  private readonly recentMaxEntries: number;
  private readonly failedLogTtlMs: number;
  private readonly failedLogMaxEntries: number;
  private readonly maxAttempts: number;
  private readonly fallbackTimeoutMs: number;

  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly attempts = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly recent = new Map<string, RecentProfileSync>();
  private readonly failedLogs = new Map<string, RateLimitedFailureLog>();
  private readonly generations = new Map<string, number>();

  schedule(input: AgentProfileSyncSchedulerInput, delayMs = 1_200): void {
    const generation = this.generationFor(input.agentId);
    const snapshotFingerprint =
      input.snapshot !== undefined ? profileSnapshotFingerprint(input.snapshot) : undefined;
    if (
      snapshotFingerprint !== undefined &&
      this.isRecentDuplicate(input.agentId, snapshotFingerprint)
    ) {
      this.metrics.profileSyncSkippedRecentDuplicateTotal += 1;
      this.logger.info("agent_profile_sync_skipped", {
        agentId: input.agentId,
        userId: input.userId,
        reason: "recent_duplicate",
        profileVersion: input.snapshot?.profileVersion,
      });
      return;
    }

    const attempt = (this.attempts.get(input.agentId) ?? 0) + 1;
    this.attempts.set(input.agentId, attempt);

    const existing = this.timers.get(input.agentId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(
      () => {
        this.timers.delete(input.agentId);
        void this.runScheduledSync(input, attempt, snapshotFingerprint, generation);
      },
      Math.max(0, delayMs),
    );

    timer.unref?.();
    this.timers.set(input.agentId, timer);
  }

  clear(agentId: string): void {
    this.bumpGeneration(agentId);
    const timer = this.timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(agentId);
    }
    this.attempts.delete(agentId);
  }

  reset(): void {
    for (const agentId of this.pendingAgentIds()) {
      this.bumpGeneration(agentId);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.attempts.clear();
    this.inFlight.clear();
    this.recent.clear();
    this.failedLogs.clear();
  }

  private async runScheduledSync(
    input: AgentProfileSyncSchedulerInput,
    attempt: number,
    snapshotFingerprint: string | undefined,
    generation: number,
  ): Promise<void> {
    if (this.isStaleGeneration(input.agentId, generation)) {
      return;
    }
    if (this.inFlight.has(input.agentId)) {
      this.metrics.profileSyncDedupedInFlightTotal += 1;
      this.logger.info("agent_profile_sync_skipped", {
        agentId: input.agentId,
        userId: input.userId,
        attempt,
        reason: "in_flight",
      });
      return;
    }

    let releaseSlot: (() => void) | null = null;
    const syncPromise = (async (): Promise<void> => {
      try {
        releaseSlot = await this.acquireSlot();
        if (input.snapshot !== undefined) {
          await this.syncFromRegisterSnapshot({
            agentId: input.agentId,
            ...(input.userId !== null ? { userId: input.userId } : {}),
            snapshot: input.snapshot,
          });
        } else {
          await this.syncFromConnectedAgent({
            agentId: input.agentId,
            ...(input.userId !== null ? { userId: input.userId } : {}),
            timeoutMs: this.fallbackTimeoutMs,
          });
        }
        if (this.isStaleGeneration(input.agentId, generation)) {
          this.attempts.delete(input.agentId);
          this.metrics.profileSyncSkippedStaleSessionTotal += 1;
          this.logger.info("agent_profile_sync_skipped", {
            agentId: input.agentId,
            userId: input.userId,
            attempt,
            reason: "stale_session",
          });
          return;
        }
        if (snapshotFingerprint !== undefined) {
          this.rememberRecent(input.agentId, snapshotFingerprint);
        }
        this.attempts.delete(input.agentId);
        this.logger.info("agent_profile_sync_success", {
          agentId: input.agentId,
          userId: input.userId,
          attempt,
          reason: input.snapshot !== undefined ? "register_snapshot" : "fallback_rpc",
        });
      } catch (error: unknown) {
        this.handleFailure(input, attempt, error, generation);
      } finally {
        releaseSlot?.();
      }
    })();

    this.inFlight.set(input.agentId, syncPromise);
    try {
      await syncPromise;
    } finally {
      this.inFlight.delete(input.agentId);
    }
  }

  private handleFailure(
    input: AgentProfileSyncSchedulerInput,
    attempt: number,
    error: unknown,
    generation: number,
  ): void {
    if (this.isStaleGeneration(input.agentId, generation)) {
      this.attempts.delete(input.agentId);
      this.metrics.profileSyncSkippedStaleSessionTotal += 1;
      this.logger.info("agent_profile_sync_skipped", {
        agentId: input.agentId,
        userId: input.userId,
        attempt,
        reason: "stale_session",
      });
      return;
    }

    const appErrorDetails =
      error instanceof AppError && typeof error.details === "object" && error.details !== null
        ? (error.details as Record<string, unknown>)
        : null;
    const retryAfterMs =
      appErrorDetails !== null && typeof appErrorDetails.retry_after_ms === "number"
        ? Math.max(0, Math.floor(appErrorDetails.retry_after_ms))
        : 0;
    const retryableProtocolWindow =
      error instanceof AppError &&
      error.code === "SERVICE_UNAVAILABLE" &&
      typeof error.message === "string" &&
      (error.message.includes("protocol negotiation is not ready") ||
        error.message.includes("Agent disconnected while waiting for response"));
    const shouldRetry = retryableProtocolWindow && attempt < this.maxAttempts;

    const logDecision = this.shouldLogFailure(input.agentId, error);
    if (logDecision.shouldLog) {
      this.logger.warn("agent_profile_sync_failed", {
        agentId: input.agentId,
        userId: input.userId,
        attempt,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof AppError ? { code: error.code, statusCode: error.statusCode } : {}),
        ...(appErrorDetails?.rpc_code !== undefined ? { rpcCode: appErrorDetails.rpc_code } : {}),
        ...(appErrorDetails?.rpc_reason !== undefined
          ? { rpcReason: appErrorDetails.rpc_reason }
          : {}),
        ...(appErrorDetails?.technical_message !== undefined
          ? { technicalMessage: appErrorDetails.technical_message }
          : {}),
        ...(appErrorDetails?.retryable !== undefined
          ? { rpcRetryable: appErrorDetails.retryable }
          : {}),
        retryAfterMs,
        shouldRetry,
        ...(logDecision.suppressedCount > 0
          ? { suppressedCount: logDecision.suppressedCount }
          : {}),
      });
    }

    if (!shouldRetry) {
      this.attempts.delete(input.agentId);
      return;
    }
    const nextDelay = retryAfterMs > 0 ? retryAfterMs : Math.min(8_000, 1_000 * attempt);
    this.schedule(input, nextDelay);
  }

  private pendingAgentIds(): Iterable<string> {
    return new Set([...this.inFlight.keys(), ...this.timers.keys(), ...this.attempts.keys()]);
  }

  private generationFor(agentId: string): number {
    return this.generations.get(agentId) ?? 0;
  }

  private bumpGeneration(agentId: string): void {
    this.generations.set(agentId, this.generationFor(agentId) + 1);
  }

  private isStaleGeneration(agentId: string, generation: number): boolean {
    return this.generationFor(agentId) !== generation;
  }

  private rememberRecent(agentId: string, fingerprint: string): void {
    const now = this.now();
    this.recent.set(agentId, {
      fingerprint,
      expiresAtMs: now + this.recentTtlMs,
    });
    this.sweepMapByExpiryAndLimit(this.recent, this.recentMaxEntries, now);
  }

  private isRecentDuplicate(agentId: string, fingerprint: string): boolean {
    const recent = this.recent.get(agentId);
    if (!recent) {
      return false;
    }
    if (recent.expiresAtMs <= this.now()) {
      this.recent.delete(agentId);
      return false;
    }
    return recent.fingerprint === fingerprint;
  }

  private shouldLogFailure(
    agentId: string,
    error: unknown,
  ): { readonly shouldLog: boolean; readonly suppressedCount: number } {
    const now = this.now();
    const key = `${agentId}:${error instanceof AppError ? error.code : "Error"}:${
      error instanceof Error ? error.message : String(error)
    }`;
    const existing = this.failedLogs.get(key);
    if (!existing || existing.expiresAtMs <= now) {
      const suppressedCount = existing?.suppressedCount ?? 0;
      this.failedLogs.set(key, {
        expiresAtMs: now + this.failedLogTtlMs,
        suppressedCount: 0,
      });
      this.sweepMapByExpiryAndLimit(this.failedLogs, this.failedLogMaxEntries, now);
      return { shouldLog: true, suppressedCount };
    }

    existing.suppressedCount += 1;
    this.metrics.profileSyncFailedLogSuppressedTotal += 1;
    return { shouldLog: false, suppressedCount: 0 };
  }

  private sweepMapByExpiryAndLimit<T extends { readonly expiresAtMs: number }>(
    map: Map<string, T>,
    maxEntries: number,
    now: number,
  ): void {
    if (map.size <= maxEntries) {
      return;
    }
    for (const [key, entry] of map) {
      if (entry.expiresAtMs <= now || map.size > maxEntries) {
        map.delete(key);
      }
      if (map.size <= maxEntries) {
        break;
      }
    }
  }
}

export const profileSnapshotFingerprint = (snapshot: AgentRegisterProfileSnapshot): string =>
  `${snapshot.profileVersion}:${snapshot.profileUpdatedAt.toISOString()}`;
