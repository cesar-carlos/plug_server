import { afterEach, expect, it, vi } from "vitest";
import { PrismaClientPasswordRecoveryResetTxn } from "../../../../src/infrastructure/persistence/prisma_client_password_recovery_reset_txn";

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  clientPasswordRecoveryToken: { deleteMany: vi.fn() },
  client: { findUnique: vi.fn() },
}));

vi.mock("../../../../src/infrastructure/database/prisma/client", () => ({
  prismaClient: { $transaction: (work: (transaction: typeof tx) => Promise<unknown>) => work(tx) },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("rejects an exactly expired recovery token before reading or changing the client", async () => {
  vi.useFakeTimers();
  const now = new Date("2026-11-06T12:00:00Z");
  vi.setSystemTime(now);
  tx.$queryRaw.mockResolvedValue([{ id: "stored", clientId: "client", expiresAt: now }]);
  await expect(
    new PrismaClientPasswordRecoveryResetTxn().resetByToken("opaque", "hash"),
  ).resolves.toEqual({ status: "expired" });
  expect(tx.client.findUnique).not.toHaveBeenCalled();
  expect(tx.clientPasswordRecoveryToken.deleteMany).toHaveBeenCalledWith({
    where: { id: "stored" },
  });
});
