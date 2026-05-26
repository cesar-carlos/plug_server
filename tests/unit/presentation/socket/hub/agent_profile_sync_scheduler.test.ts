import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentProfileSyncScheduler,
  type AgentProfileSyncSchedulerLogger,
  type AgentProfileSyncSchedulerMetrics,
} from "../../../../../src/presentation/socket/hub/scheduling/agent_profile_sync_scheduler";
import { AppError } from "../../../../../src/shared/errors/app_error";

const snapshot = {
  profile: { name: "Snapshot Agent" },
  profileVersion: 7,
  profileUpdatedAt: new Date("2026-05-12T10:00:00.000Z"),
};

const createDeferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("AgentProfileSyncScheduler", () => {
  let metrics: AgentProfileSyncSchedulerMetrics;
  let logger: AgentProfileSyncSchedulerLogger;
  let nowMs: number;
  let releaseSlot: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = {
      profileSyncDedupedInFlightTotal: 0,
      profileSyncSkippedRecentDuplicateTotal: 0,
      profileSyncSkippedStaleSessionTotal: 0,
      profileSyncFailedLogSuppressedTotal: 0,
    };
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    nowMs = Date.parse("2026-05-12T10:00:00.000Z");
    releaseSlot = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should dedupe sync while another sync for the same agent is in flight", async () => {
    const deferred = createDeferred();
    const syncFromRegisterSnapshot = vi.fn(async () => deferred.promise);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot,
      syncFromConnectedAgent: vi.fn(),
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1", snapshot }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFromRegisterSnapshot).toHaveBeenCalledTimes(1);

    scheduler.schedule({ agentId: "agent-1", userId: "user-1", snapshot }, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(syncFromRegisterSnapshot).toHaveBeenCalledTimes(1);
    expect(metrics.profileSyncDedupedInFlightTotal).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "agent_profile_sync_skipped",
      expect.objectContaining({ agentId: "agent-1", reason: "in_flight" }),
    );

    deferred.resolve();
    await deferred.promise;
    await Promise.resolve();
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("should skip recent duplicate snapshots until TTL expires", async () => {
    const syncFromRegisterSnapshot = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot,
      syncFromConnectedAgent: vi.fn(),
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
      options: { recentTtlMs: 100 },
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1", snapshot }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFromRegisterSnapshot).toHaveBeenCalledTimes(1);

    scheduler.schedule({ agentId: "agent-1", userId: "user-1", snapshot }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFromRegisterSnapshot).toHaveBeenCalledTimes(1);
    expect(metrics.profileSyncSkippedRecentDuplicateTotal).toBe(1);

    nowMs += 101;
    scheduler.schedule({ agentId: "agent-1", userId: "user-1", snapshot }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFromRegisterSnapshot).toHaveBeenCalledTimes(2);
  });

  it("should retry retryable protocol-window failures and then succeed", async () => {
    const syncFromConnectedAgent = vi
      .fn()
      .mockRejectedValueOnce(
        new AppError("protocol negotiation is not ready", {
          statusCode: 503,
          code: "SERVICE_UNAVAILABLE",
          details: { retry_after_ms: 25 },
        }),
      )
      .mockResolvedValueOnce(undefined);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot: vi.fn(),
      syncFromConnectedAgent,
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
      options: { fallbackTimeoutMs: 1234 },
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1" }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFromConnectedAgent).toHaveBeenCalledTimes(1);
    expect(syncFromConnectedAgent).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      userId: "user-1",
      timeoutMs: 1234,
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(syncFromConnectedAgent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(syncFromConnectedAgent).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_profile_sync_failed",
      expect.objectContaining({ agentId: "agent-1", shouldRetry: true }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "agent_profile_sync_success",
      expect.objectContaining({ agentId: "agent-1", attempt: 2, reason: "fallback_rpc" }),
    );
  });

  it("should suppress repeated failure warnings within the rate-limit TTL", async () => {
    const error = new Error("Authentication failed");
    const syncFromConnectedAgent = vi.fn().mockRejectedValue(error);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot: vi.fn(),
      syncFromConnectedAgent,
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
      options: { failedLogTtlMs: 100, maxAttempts: 1 },
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1" }, 0);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.schedule({ agentId: "agent-1", userId: "user-1" }, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(metrics.profileSyncFailedLogSuppressedTotal).toBe(1);

    nowMs += 101;
    scheduler.schedule({ agentId: "agent-1", userId: "user-1" }, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "agent_profile_sync_failed",
      expect.objectContaining({ suppressedCount: 1 }),
    );
    expect(metrics.profileSyncFailedLogSuppressedTotal).toBe(1);
  });

  it("should not retry an in-flight sync after the agent state is cleared", async () => {
    const deferred = createDeferred();
    const syncFromConnectedAgent = vi.fn(async () => deferred.promise);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot: vi.fn(),
      syncFromConnectedAgent,
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1" }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncFromConnectedAgent).toHaveBeenCalledTimes(1);

    scheduler.clear("agent-1");
    deferred.reject(
      new AppError("Agent disconnected while waiting for response", {
        statusCode: 503,
        code: "SERVICE_UNAVAILABLE",
      }),
    );
    await deferred.promise.catch(() => undefined);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8_000);

    expect(syncFromConnectedAgent).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "agent_profile_sync_skipped",
      expect.objectContaining({ agentId: "agent-1", reason: "stale_session" }),
    );
    expect(metrics.profileSyncSkippedStaleSessionTotal).toBe(1);
    expect(logger.warn).not.toHaveBeenCalledWith("agent_profile_sync_failed", expect.any(Object));
  });

  it("should not run a pending timer after the scheduler is reset", async () => {
    const syncFromConnectedAgent = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot: vi.fn(),
      syncFromConnectedAgent,
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1" }, 1_000);
    scheduler.reset();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(syncFromConnectedAgent).not.toHaveBeenCalled();
  });

  it("should skip success bookkeeping when sync completes after the agent state is cleared", async () => {
    const deferred = createDeferred();
    const syncFromRegisterSnapshot = vi.fn(async () => deferred.promise);
    const scheduler = new AgentProfileSyncScheduler({
      syncFromRegisterSnapshot,
      syncFromConnectedAgent: vi.fn(),
      acquireSlot: async () => releaseSlot,
      metrics,
      logger,
      now: () => nowMs,
    });

    scheduler.schedule({ agentId: "agent-1", userId: "user-1", snapshot }, 0);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.clear("agent-1");

    deferred.resolve();
    await deferred.promise.catch(() => undefined);
    await Promise.resolve();

    expect(logger.info).not.toHaveBeenCalledWith(
      "agent_profile_sync_success",
      expect.objectContaining({ agentId: "agent-1" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "agent_profile_sync_skipped",
      expect.objectContaining({ agentId: "agent-1", reason: "stale_session" }),
    );
    expect(metrics.profileSyncSkippedStaleSessionTotal).toBe(1);
  });
});
