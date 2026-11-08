import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  pwaDelivery: { findFirst: vi.fn(), updateMany: vi.fn() },
  pwaSubscription: { findUnique: vi.fn() },
}));
vi.mock("../../../../src/infrastructure/database/prisma/client", () => ({ prismaClient: db }));
import { PrismaPwaPushStore } from "../../../../src/infrastructure/repositories/prisma_pwa_push_store";

describe("PWA claim progress", () => {
  const now = new Date("2026-11-08T00:00:00Z");
  const row = {
    id: "first",
    attempts: 0,
    clientId: "client",
    installationId: "install",
    type: "access-approved",
    eventId: "event",
  };
  const subscription = {
    clientId: "client",
    installationId: "install",
    endpoint: "https://test.invalid",
    auth: "fixture",
    p256dh: "fixture",
  };
  beforeEach(() => {
    vi.resetAllMocks();
    db.pwaDelivery.updateMany.mockResolvedValue({ count: 1 });
    db.pwaSubscription.findUnique.mockResolvedValue(subscription);
  });
  it("claims the next job after losing a lease race", async () => {
    db.pwaDelivery.findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, id: "next" });
    db.pwaDelivery.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(new PrismaPwaPushStore().claim(now)).resolves.toMatchObject({
      id: "next",
      attempts: 1,
    });
    expect(db.pwaSubscription.findUnique).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "foreign", "invalid-type"])(
    "continues after a %s job without sending it",
    async (kind) => {
      db.pwaDelivery.findFirst
        .mockResolvedValueOnce({ ...row, type: kind === "invalid-type" ? "invalid" : row.type })
        .mockResolvedValueOnce({ ...row, id: "next" });
      if (kind === "missing") db.pwaSubscription.findUnique.mockResolvedValueOnce(null);
      if (kind === "foreign")
        db.pwaSubscription.findUnique.mockResolvedValueOnce({ ...subscription, clientId: "other" });
      await expect(new PrismaPwaPushStore().claim(now)).resolves.toMatchObject({ id: "next" });
      expect(db.pwaDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: "first" },
        data: { done: true },
      });
    },
  );
  it("bounds contention work and does not fetch subscriptions without a lease", async () => {
    db.pwaDelivery.findFirst.mockResolvedValue(row);
    db.pwaDelivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(new PrismaPwaPushStore().claim(now)).resolves.toBeNull();
    expect(db.pwaDelivery.findFirst).toHaveBeenCalledTimes(20);
    expect(db.pwaSubscription.findUnique).not.toHaveBeenCalled();
  });
  it("returns immediately when no eligible job exists", async () => {
    db.pwaDelivery.findFirst.mockResolvedValue(null);
    await expect(new PrismaPwaPushStore().claim(now)).resolves.toBeNull();
    expect(db.pwaDelivery.updateMany).not.toHaveBeenCalled();
  });
  it("preserves persistence failures", async () => {
    db.pwaDelivery.findFirst.mockRejectedValue(new Error("database unavailable"));
    await expect(new PrismaPwaPushStore().claim(now)).rejects.toThrow("database unavailable");
  });
});
