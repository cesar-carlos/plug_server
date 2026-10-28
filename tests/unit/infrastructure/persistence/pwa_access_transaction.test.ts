import { beforeEach, describe, expect, it, vi } from "vitest";
const tx = vi.hoisted(() => ({
  clientAgentAccessRequest: { updateMany: vi.fn() },
  clientAgentAccess: { upsert: vi.fn(), deleteMany: vi.fn() },
  clientAgentAccessApprovalToken: { deleteMany: vi.fn() },
  pwaSubscription: { findMany: vi.fn() },
  pwaDelivery: { createMany: vi.fn() },
}));
vi.mock("../../../../src/infrastructure/database/prisma/client", () => ({
  prismaClient: { $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) },
}));
import { PrismaClientAgentAccessApprovalTxn } from "../../../../src/infrastructure/persistence/prisma_client_agent_access_approval_txn";

describe("access decision delivery persistence", () => {
  const adapter = new PrismaClientAgentAccessApprovalTxn();
  const input = {
    requestId: "request",
    clientId: "client",
    agentId: "agent",
    approvedAt: new Date(),
    pushEventId: "event",
  };
  beforeEach(() => {
    vi.resetAllMocks();
    tx.clientAgentAccessRequest.updateMany.mockResolvedValue({ count: 1 });
    tx.clientAgentAccess.deleteMany.mockResolvedValue({ count: 1 });
    tx.pwaSubscription.findMany.mockResolvedValue([{ installationId: "installation" }]);
  });
  it("rejects approval when delivery cannot be persisted in the same transaction", async () => {
    tx.pwaDelivery.createMany.mockRejectedValue(new Error("disk failure"));
    await expect(adapter.approvePendingAndGrantAccess(input)).rejects.toThrow("disk failure");
  });
  it("persists approval delivery before returning success", async () => {
    await expect(adapter.approvePendingAndGrantAccess(input)).resolves.toBe(true);
    expect(tx.pwaDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          clientId: "client",
          installationId: "installation",
          eventId: "event",
          type: "access-approved",
        }),
      ],
      skipDuplicates: true,
    });
  });
  it("does not enqueue a second approval after a concurrent decision", async () => {
    tx.clientAgentAccessRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(adapter.approvePendingAndGrantAccess(input)).resolves.toBe(false);
    expect(tx.pwaDelivery.createMany).not.toHaveBeenCalled();
  });
  it("rejects revocation when its delivery cannot be persisted", async () => {
    tx.pwaDelivery.createMany.mockRejectedValue(new Error("disk failure"));
    await expect(adapter.revokeAccess({ ...input, reason: "owner" })).rejects.toThrow(
      "disk failure",
    );
  });
  it("does not notify repeated revocation", async () => {
    tx.clientAgentAccess.deleteMany.mockResolvedValue({ count: 0 });
    await expect(adapter.revokeAccess({ ...input, reason: "owner" })).resolves.toBe(false);
    expect(tx.pwaDelivery.createMany).not.toHaveBeenCalled();
  });
  it("does not access push tables when push is disabled", async () => {
    const { pushEventId: _, ...disabled } = input;
    await adapter.approvePendingAndGrantAccess(disabled);
    expect(tx.pwaSubscription.findMany).not.toHaveBeenCalled();
  });
});
