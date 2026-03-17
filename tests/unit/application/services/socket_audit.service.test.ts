import { describe, expect, it, vi } from "vitest";

describe("socket_audit.service", () => {
  it("should ignore missing audit table errors when recording audit events", async () => {
    vi.resetModules();
    const warn = vi.fn();

    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: vi.fn().mockResolvedValue([{ exists: true }]),
        $executeRaw: vi.fn().mockRejectedValue(new Error('relation "audit_events" does not exist')),
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn, error: vi.fn() },
    }));

    const { recordSocketAuditEvent } = await import(
      "../../../../src/application/services/socket_audit.service"
    );

    await expect(
      recordSocketAuditEvent({
        eventType: "relay:conversation.start",
        actorSocketId: "socket-1",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("should prune audit events older than the configured retention", async () => {
    vi.resetModules();

    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: vi.fn().mockResolvedValue([{ exists: true }]),
        $executeRaw: vi.fn().mockResolvedValue(3),
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { pruneSocketAuditOlderThanDays } = await import(
      "../../../../src/application/services/socket_audit.service"
    );

    await expect(pruneSocketAuditOlderThanDays(90)).resolves.toBe(3);
  });
});
