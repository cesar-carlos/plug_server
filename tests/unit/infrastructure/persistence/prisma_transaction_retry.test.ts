import { describe, expect, it, vi } from "vitest";

import {
  isPrismaTransientTransactionError,
  runPrismaTransactionWithRetry,
} from "../../../../src/infrastructure/persistence/prisma_transaction_retry";

describe("prisma_transaction_retry", () => {
  it("should identify nested PostgreSQL serialization/deadlock codes as transient", () => {
    expect(isPrismaTransientTransactionError({ cause: { code: "40001" } })).toBe(true);
    expect(isPrismaTransientTransactionError({ cause: { code: "40P01" } })).toBe(true);
    expect(isPrismaTransientTransactionError({ cause: { code: "23505" } })).toBe(false);
  });

  it("should retry transient transaction failures", async () => {
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ cause: { code: "40001" } })
      .mockResolvedValueOnce("ok");

    await expect(runPrismaTransactionWithRetry("unit_retry", work)).resolves.toBe("ok");
    expect(work).toHaveBeenCalledTimes(2);
  });
});
