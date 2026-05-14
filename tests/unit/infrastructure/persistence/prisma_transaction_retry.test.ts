import { describe, expect, it, vi } from "vitest";

import {
  getPrismaTransactionRetryMetricsSnapshot,
  resetPrismaTransactionRetryMetricsForTests,
} from "../../../../src/application/services/prisma_transaction_retry_metrics.service";
import {
  isPrismaTransientTransactionError,
  runPrismaTransactionWithRetry,
} from "../../../../src/infrastructure/persistence/prisma_transaction_retry";

describe("prisma_transaction_retry", () => {
  it("starts with clean retry metrics", () => {
    resetPrismaTransactionRetryMetricsForTests();
    expect(getPrismaTransactionRetryMetricsSnapshot()).toMatchObject({
      retryAttemptsTotal: 0,
      retriesExhaustedTotal: 0,
    });
  });

  it("should identify nested PostgreSQL serialization/deadlock codes as transient", () => {
    expect(isPrismaTransientTransactionError({ cause: { code: "40001" } })).toBe(true);
    expect(isPrismaTransientTransactionError({ cause: { code: "40P01" } })).toBe(true);
    expect(isPrismaTransientTransactionError({ cause: { code: "23505" } })).toBe(false);
  });

  it("should retry transient transaction failures", async () => {
    resetPrismaTransactionRetryMetricsForTests();
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ cause: { code: "40001" } })
      .mockResolvedValueOnce("ok");

    await expect(runPrismaTransactionWithRetry("unit_retry", work)).resolves.toBe("ok");
    expect(work).toHaveBeenCalledTimes(2);
    expect(getPrismaTransactionRetryMetricsSnapshot()).toMatchObject({
      retryAttemptsTotal: 1,
      retriesExhaustedTotal: 0,
    });
    expect(
      getPrismaTransactionRetryMetricsSnapshot().retryAttemptsByOperation.get("unit_retry"),
    ).toBe(1);
  });

  it("records exhausted retries for transient failures that never succeed", async () => {
    resetPrismaTransactionRetryMetricsForTests();
    const work = vi.fn<() => Promise<string>>().mockRejectedValue({ cause: { code: "40001" } });

    await expect(runPrismaTransactionWithRetry("unit_exhausted", work)).rejects.toEqual({
      cause: { code: "40001" },
    });
    expect(getPrismaTransactionRetryMetricsSnapshot()).toMatchObject({
      retryAttemptsTotal: 2,
      retriesExhaustedTotal: 1,
    });
    expect(
      getPrismaTransactionRetryMetricsSnapshot().retriesExhaustedByOperation.get("unit_exhausted"),
    ).toBe(1);
  });
});
