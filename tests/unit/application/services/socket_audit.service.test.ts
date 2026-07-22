import { afterEach, describe, expect, it, vi } from "vitest";

import { socketEvents } from "../../../../src/shared/constants/socket_events";

describe("socket_audit.service", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("should ignore missing audit table errors when recording audit events", async () => {
    vi.resetModules();
    const warn = vi.fn();

    vi.doMock("../../../../src/shared/config/env", () => ({
      env: {
        socketAuditBatchMax: 1,
        socketAuditBatchFlushMs: 150,
        socketAuditPruneBatchSize: 5000,
      },
    }));
    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: vi.fn().mockResolvedValue([{ exists: true }]),
        $executeRaw: vi.fn().mockRejectedValue(new Error('relation "audit_events" does not exist')),
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn, error: vi.fn() },
    }));

    const { recordSocketAuditEvent } =
      await import("../../../../src/application/services/socket_audit.service");

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

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([{ deleted: 3 }]);

    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: queryRaw,
        $executeRaw: vi.fn(),
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { pruneSocketAuditOlderThanDays } =
      await import("../../../../src/application/services/socket_audit.service");

    await expect(pruneSocketAuditOlderThanDays(90)).resolves.toBe(3);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("should sample-skip high-volume relay unary audit events when percent is below 100", async () => {
    vi.resetModules();
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    vi.doMock("../../../../src/shared/config/env", () => ({
      env: {
        socketAuditBatchMax: 1,
        socketAuditBatchFlushMs: 150,
        socketAuditMaxQueue: 0,
        socketAuditHighVolumeSamplePercent: 50,
        socketAuditPruneBatchSize: 5000,
      },
    }));
    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: vi.fn().mockResolvedValue([{ exists: true }]),
        $executeRaw: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { recordSocketAuditEvent, getSocketAuditMetricsSnapshot } =
      await import("../../../../src/application/services/socket_audit.service");

    await recordSocketAuditEvent({
      eventType: socketEvents.relayRpcRequest,
      actorSocketId: "socket-1",
    });
    await recordSocketAuditEvent({
      eventType: socketEvents.relayRpcResponse,
      actorSocketId: "socket-2",
    });
    await recordSocketAuditEvent({
      eventType: socketEvents.relayRpcChunk,
      actorSocketId: "socket-3",
    });

    const metrics = getSocketAuditMetricsSnapshot();
    expect(metrics.writesAttempted).toBe(3);
    expect(metrics.writesSampleSkipped).toBe(3);
    expect(metrics.writesSucceeded).toBe(0);
  });

  it("should still persist low-volume audit events when high-volume sample percent is below 100", async () => {
    vi.resetModules();

    const executeRaw = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../../../src/shared/config/env", () => ({
      env: {
        socketAuditBatchMax: 1,
        socketAuditBatchFlushMs: 150,
        socketAuditMaxQueue: 0,
        socketAuditHighVolumeSamplePercent: 25,
        socketAuditPruneBatchSize: 5000,
      },
    }));
    vi.doMock("../../../../src/infrastructure/database/prisma/client", () => ({
      prismaClient: {
        $queryRaw: vi.fn().mockResolvedValue([{ exists: true }]),
        $executeRaw: executeRaw,
      },
    }));
    vi.doMock("../../../../src/shared/utils/logger", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { recordSocketAuditEvent, getSocketAuditMetricsSnapshot } =
      await import("../../../../src/application/services/socket_audit.service");

    await recordSocketAuditEvent({
      eventType: socketEvents.relayConversationStart,
      actorSocketId: "socket-1",
    });

    const metrics = getSocketAuditMetricsSnapshot();
    expect(metrics.writesAttempted).toBe(1);
    expect(metrics.writesSampleSkipped).toBe(0);
    expect(metrics.writesSucceeded).toBe(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
