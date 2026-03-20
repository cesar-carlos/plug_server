import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prismaClient } from "../../infrastructure/database/prisma/client";
import { socketEvents } from "../../shared/constants/socket_events";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

const defaultRetentionDays = 90;
const defaultRetentionIntervalMs = 24 * 60 * 60 * 1000;
const defaultPruneBatchSize = env.socketAuditPruneBatchSize;

let retentionTimer: NodeJS.Timeout | null = null;
let missingTableLogged = false;
let auditTableState: "unknown" | "available" | "missing" = "unknown";
const pendingAuditOperations = new Set<Promise<unknown>>();

const auditMetrics = {
  writesAttempted: 0,
  writesSucceeded: 0,
  writesFailed: 0,
  writesSkippedTableMissing: 0,
  writesSampleSkipped: 0,
  pruneRuns: 0,
  pruneDeleted: 0,
  pruneFailed: 0,
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const shouldSampleSkipHighVolumeAudit = (input: SocketAuditEventInput): boolean => {
  const pct = env.socketAuditHighVolumeSamplePercent;
  if (pct >= 100) {
    return false;
  }
  if (input.eventType !== socketEvents.relayRpcChunk) {
    return false;
  }
  return Math.random() * 100 >= pct;
};

const isAuditTableMissing = (error: unknown): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("audit_events") && message.includes("does not exist");
};

const trackPendingAuditOperation = async <T>(operation: Promise<T>): Promise<T> => {
  pendingAuditOperations.add(operation);
  try {
    return await operation;
  } finally {
    pendingAuditOperations.delete(operation);
  }
};

const canUseAuditTable = async (): Promise<boolean> => {
  if (auditTableState === "available") {
    return true;
  }

  if (auditTableState === "missing") {
    return false;
  }

  try {
    const rows = await prismaClient.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.audit_events') IS NOT NULL AS "exists"
    `;
    const exists = rows[0]?.exists === true;
    auditTableState = exists ? "available" : "missing";

    if (!exists && !missingTableLogged) {
      logger.warn("socket_audit_table_missing", { message: "audit_events table not found" });
      missingTableLogged = true;
    }

    return exists;
  } catch (error: unknown) {
    logger.warn("socket_audit_table_probe_failed", { message: toErrorMessage(error) });
    return false;
  }
};

export interface SocketAuditEventInput {
  readonly eventType: string;
  readonly actorSocketId?: string;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly direction?: "consumer_to_agent" | "agent_to_consumer" | "control";
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly requestId?: string;
  readonly streamId?: string;
  readonly traceId?: string;
  readonly payload?: unknown;
}

const auditEventQueue: SocketAuditEventInput[] = [];
let auditBatchDebounceTimer: NodeJS.Timeout | null = null;
/** Chains flush work so concurrent producers do not drop batches. */
let auditFlushChain: Promise<void> = Promise.resolve();

const insertAuditEventRow = async (
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
  input: SocketAuditEventInput,
): Promise<void> => {
  await client.$executeRaw`
    INSERT INTO audit_events (
      id,
      event_type,
      actor_socket_id,
      actor_user_id,
      actor_role,
      direction,
      conversation_id,
      agent_id,
      request_id,
      stream_id,
      trace_id,
      payload_json
    ) VALUES (
      ${randomUUID()},
      ${input.eventType},
      ${input.actorSocketId ?? null},
      ${input.actorUserId ?? null},
      ${input.actorRole ?? null},
      ${input.direction ?? null},
      ${input.conversationId ?? null},
      ${input.agentId ?? null},
      ${input.requestId ?? null},
      ${input.streamId ?? null},
      ${input.traceId ?? null},
      ${JSON.stringify(input.payload ?? null)}::jsonb
    )
  `;
};

const performAuditFlush = async (): Promise<void> => {
  if (auditBatchDebounceTimer) {
    clearTimeout(auditBatchDebounceTimer);
    auditBatchDebounceTimer = null;
  }

  while (auditEventQueue.length > 0) {
    if (!(await canUseAuditTable())) {
      const dropped = auditEventQueue.length;
      auditMetrics.writesSkippedTableMissing += dropped;
      auditEventQueue.length = 0;
      return;
    }

    const batch = auditEventQueue.splice(0, env.socketAuditBatchMax);
    await trackPendingAuditOperation(
      (async () => {
        try {
          await prismaClient.$transaction(async (tx) => {
            for (const row of batch) {
              await insertAuditEventRow(tx, row);
            }
          });
          auditMetrics.writesSucceeded += batch.length;
        } catch (error: unknown) {
          if (isAuditTableMissing(error)) {
            auditTableState = "missing";
            auditMetrics.writesSkippedTableMissing += batch.length;
            if (!missingTableLogged) {
              logger.warn("socket_audit_table_missing", { message: toErrorMessage(error) });
              missingTableLogged = true;
            }
            return;
          }

          auditMetrics.writesFailed += batch.length;
          logger.warn("socket_audit_write_failed", { message: toErrorMessage(error) });
        }
      })(),
    );
  }
};

const queueAuditFlush = (): void => {
  auditFlushChain = auditFlushChain
    .then(() => performAuditFlush())
    .catch((error: unknown) => {
      logger.warn("socket_audit_flush_chain_failed", { message: toErrorMessage(error) });
    });
};

const scheduleDebouncedAuditFlush = (): void => {
  if (auditBatchDebounceTimer) {
    return;
  }
  auditBatchDebounceTimer = setTimeout(() => {
    auditBatchDebounceTimer = null;
    queueAuditFlush();
  }, env.socketAuditBatchFlushMs);
  auditBatchDebounceTimer.unref?.();
};

/** Await during shutdown so queued batched events hit the database. */
export const flushPendingSocketAuditEvents = async (): Promise<void> => {
  if (env.socketAuditBatchMax <= 1) {
    return;
  }
  if (auditBatchDebounceTimer) {
    clearTimeout(auditBatchDebounceTimer);
    auditBatchDebounceTimer = null;
  }
  queueAuditFlush();
  await auditFlushChain;
};

export const recordSocketAuditEvent = async (input: SocketAuditEventInput): Promise<void> => {
  auditMetrics.writesAttempted += 1;

  if (shouldSampleSkipHighVolumeAudit(input)) {
    auditMetrics.writesSampleSkipped += 1;
    return;
  }

  if (env.socketAuditBatchMax <= 1) {
    if (!(await canUseAuditTable())) {
      auditMetrics.writesSkippedTableMissing += 1;
      return;
    }

    await trackPendingAuditOperation(
      (async () => {
        try {
          await insertAuditEventRow(prismaClient, input);
          auditMetrics.writesSucceeded += 1;
        } catch (error: unknown) {
          if (isAuditTableMissing(error)) {
            auditTableState = "missing";
            auditMetrics.writesSkippedTableMissing += 1;
            if (!missingTableLogged) {
              logger.warn("socket_audit_table_missing", { message: toErrorMessage(error) });
              missingTableLogged = true;
            }
            return;
          }

          auditMetrics.writesFailed += 1;
          logger.warn("socket_audit_write_failed", { message: toErrorMessage(error) });
        }
      })(),
    );
    return;
  }

  auditEventQueue.push(input);
  if (auditEventQueue.length >= env.socketAuditBatchMax) {
    queueAuditFlush();
  } else {
    scheduleDebouncedAuditFlush();
  }
};

const toNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

export const pruneSocketAuditOlderThanDays = async (
  retentionDays = defaultRetentionDays,
  options?: { readonly batchSize?: number },
): Promise<number> => {
  auditMetrics.pruneRuns += 1;

  if (!(await canUseAuditTable())) {
    return 0;
  }

  const safeDays = Number.isFinite(retentionDays) ? Math.max(1, Math.floor(retentionDays)) : defaultRetentionDays;
  const safeBatchSize = Number.isFinite(options?.batchSize)
    ? Math.max(100, Math.floor(options?.batchSize ?? defaultPruneBatchSize))
    : defaultPruneBatchSize;
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  return trackPendingAuditOperation(
    (async () => {
      try {
        let totalDeleted = 0;

        while (true) {
          const rows = await prismaClient.$queryRaw<Array<{ deleted: number | bigint }>>`
            WITH candidate AS (
              SELECT id
              FROM audit_events
              WHERE created_at < ${cutoff}
              ORDER BY created_at ASC
              LIMIT ${safeBatchSize}
            ),
            deleted AS (
              DELETE FROM audit_events target
              USING candidate
              WHERE target.id = candidate.id
              RETURNING target.id
            )
            SELECT COUNT(*)::int AS deleted FROM deleted
          `;

          const deletedInBatch = toNumber(rows[0]?.deleted ?? 0);
          totalDeleted += deletedInBatch;
          if (deletedInBatch < safeBatchSize) {
            break;
          }
        }

        auditMetrics.pruneDeleted += totalDeleted;

        if (totalDeleted > 0) {
          logger.info("socket_audit_pruned", {
            deleted: totalDeleted,
            retentionDays: safeDays,
            batchSize: safeBatchSize,
          });
        }

        return totalDeleted;
      } catch (error: unknown) {
        if (isAuditTableMissing(error)) {
          auditTableState = "missing";
          if (!missingTableLogged) {
            logger.warn("socket_audit_table_missing", { message: toErrorMessage(error) });
            missingTableLogged = true;
          }
        } else {
          logger.warn("socket_audit_prune_failed", { message: toErrorMessage(error) });
        }

        auditMetrics.pruneFailed += 1;
        return 0;
      }
    })(),
  );
};

export const startSocketAuditRetentionScheduler = (options?: {
  readonly retentionDays?: number;
  readonly intervalMs?: number;
  readonly batchSize?: number;
}): void => {
  if (retentionTimer) {
    return;
  }

  const retentionDays = options?.retentionDays ?? defaultRetentionDays;
  const intervalMs = options?.intervalMs ?? defaultRetentionIntervalMs;
  const batchSize = options?.batchSize ?? defaultPruneBatchSize;

  const run = (): void => {
    void pruneSocketAuditOlderThanDays(retentionDays, { batchSize });
  };

  run();
  retentionTimer = setInterval(run, intervalMs);
  retentionTimer.unref?.();
};

export const stopSocketAuditRetentionScheduler = (): void => {
  if (!retentionTimer) {
    return;
  }
  clearInterval(retentionTimer);
  retentionTimer = null;
};

export const waitForSocketAuditDrain = async (
  timeoutMs = 2_000,
): Promise<{ readonly drained: boolean; readonly pending: number }> => {
  const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(50, Math.floor(timeoutMs)) : 2_000;
  const deadlineMs = Date.now() + safeTimeoutMs;

  while (pendingAuditOperations.size > 0 && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    drained: pendingAuditOperations.size === 0,
    pending: pendingAuditOperations.size,
  };
};

export const getSocketAuditMetricsSnapshot = (): {
  readonly writesAttempted: number;
  readonly writesSucceeded: number;
  readonly writesFailed: number;
  readonly writesSkippedTableMissing: number;
  readonly writesSampleSkipped: number;
  readonly pruneRuns: number;
  readonly pruneDeleted: number;
  readonly pruneFailed: number;
  readonly pendingOperations: number;
  readonly queuedEvents: number;
} => ({
  writesAttempted: auditMetrics.writesAttempted,
  writesSucceeded: auditMetrics.writesSucceeded,
  writesFailed: auditMetrics.writesFailed,
  writesSkippedTableMissing: auditMetrics.writesSkippedTableMissing,
  writesSampleSkipped: auditMetrics.writesSampleSkipped,
  pruneRuns: auditMetrics.pruneRuns,
  pruneDeleted: auditMetrics.pruneDeleted,
  pruneFailed: auditMetrics.pruneFailed,
  pendingOperations: pendingAuditOperations.size,
  queuedEvents: auditEventQueue.length,
});

