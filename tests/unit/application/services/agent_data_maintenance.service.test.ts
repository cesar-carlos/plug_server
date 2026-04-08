import { describe, expect, it, vi } from "vitest";

describe("agent_data_maintenance.service", () => {
  it("should prune old agent profile revisions and idempotency rows", async () => {
    vi.resetModules();

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ revisionsExists: true, idempotenciesExists: true }])
      .mockResolvedValueOnce([{ deleted: 2 }])
      .mockResolvedValueOnce([{ deleted: 4 }]);

    vi.doMock("../../../../src/shared/config/env", () => ({
      env: {
        agentProfileRevisionRetentionDays: 180,
        agentProfileIdempotencyRetentionDays: 30,
        agentProfileMaintenancePruneBatchSize: 5_000,
        agentProfileMaintenanceIntervalMinutes: 1_440,
        clientAgentAccessExpirySweepBatchSize: 1_000,
        clientAgentAccessExpirySweepIntervalMinutes: 60,
      },
    }));
    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: queryRaw,
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { pruneAgentProfileData, getAgentDataMaintenanceMetricsSnapshot } = await import(
      "../../../../src/application/services/agent_data_maintenance.service"
    );

    await expect(pruneAgentProfileData()).resolves.toEqual({
      revisionsDeleted: 2,
      idempotencyDeleted: 4,
    });
    expect(getAgentDataMaintenanceMetricsSnapshot()).toMatchObject({
      profilePruneRuns: 1,
      profileRevisionsDeleted: 2,
      profileIdempotencyDeleted: 4,
      profilePruneFailed: 0,
    });
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it("should expire pending client-agent requests whose approval token elapsed", async () => {
    vi.resetModules();

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ requestsExists: true, tokensExists: true }])
      .mockResolvedValueOnce([{ deleted: 0 }]);
    const txQueryRaw = vi.fn().mockResolvedValue([{ expired: 3, deleted: 3 }]);
    const transaction = vi.fn(async (callback: (tx: { $queryRaw: typeof txQueryRaw }) => unknown) =>
      callback({ $queryRaw: txQueryRaw }),
    );

    vi.doMock("../../../../src/shared/config/env", () => ({
      env: {
        agentProfileRevisionRetentionDays: 180,
        agentProfileIdempotencyRetentionDays: 30,
        agentProfileMaintenancePruneBatchSize: 5_000,
        agentProfileMaintenanceIntervalMinutes: 1_440,
        clientAgentAccessExpirySweepBatchSize: 1_000,
        clientAgentAccessExpirySweepIntervalMinutes: 60,
      },
    }));
    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: queryRaw,
        $transaction: transaction,
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const {
      sweepExpiredClientAgentAccessData,
      getAgentDataMaintenanceMetricsSnapshot,
    } = await import("../../../../src/application/services/agent_data_maintenance.service");

    await expect(sweepExpiredClientAgentAccessData()).resolves.toEqual({
      requestsExpired: 3,
      tokensDeleted: 3,
    });
    expect(getAgentDataMaintenanceMetricsSnapshot()).toMatchObject({
      clientAccessExpiryRuns: 1,
      clientAccessRequestsExpired: 3,
      clientAccessTokensDeleted: 3,
      clientAccessExpiryFailed: 0,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
  });
});
