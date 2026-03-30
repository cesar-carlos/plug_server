import type { Prisma } from "@prisma/client";

import { prismaClient } from "../../infrastructure/database/prisma/client";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

export interface BridgeLatencyTraceRowInput {
  readonly id: string;
  readonly channel: string;
  readonly requestId: string;
  readonly traceId: string | null;
  readonly agentId: string;
  readonly userId: string | null;
  readonly jsonRpcMethod: string | null;
  readonly totalMs: number;
  readonly phasesSumMs: number;
  readonly phasesSchemaVersion: number;
  readonly phasesMs: Record<string, number>;
  readonly outcome: string;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
}

const pendingOperations = new Set<Promise<unknown>>();

const traceMetrics = {
  enqueued: 0,
  writesSucceeded: 0,
  writesFailed: 0,
  writesSkippedTableMissing: 0,
  writesDroppedQueueFull: 0,
  persistSkipped: 0,
  phasesMismatchTotal: 0,
  pruneRuns: 0,
  pruneDeleted: 0,
  pruneFailed: 0,
};

let tableState: "unknown" | "available" | "missing" = "unknown";
let missingTableLogged = false;

const traceQueue: BridgeLatencyTraceRowInput[] = [];
let batchDebounceTimer: NodeJS.Timeout | null = null;
let flushChain: Promise<void> = Promise.resolve();

let retentionTimer: NodeJS.Timeout | null = null;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isTraceTableMissing = (error: unknown): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("bridge_latency_traces") && message.includes("does not exist");
};

const trackPending = async <T>(operation: Promise<T>): Promise<T> => {
  pendingOperations.add(operation);
  try {
    return await operation;
  } finally {
    pendingOperations.delete(operation);
  }
};

const canUseTraceTable = async (): Promise<boolean> => {
  if (tableState === "available") {
    return true;
  }
  if (tableState === "missing") {
    return false;
  }

  try {
    const rows = await prismaClient.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.bridge_latency_traces') IS NOT NULL AS "exists"
    `;
    const exists = rows[0]?.exists === true;
    tableState = exists ? "available" : "missing";

    if (!exists && !missingTableLogged) {
      logger.warn("bridge_latency_traces_table_missing", {
        message: "bridge_latency_traces table not found",
      });
      missingTableLogged = true;
    }

    return exists;
  } catch (error: unknown) {
    logger.warn("bridge_latency_traces_table_probe_failed", { message: toErrorMessage(error) });
    return false;
  }
};

const insertRow = async (
  client: Pick<Prisma.TransactionClient, "bridgeLatencyTrace">,
  row: BridgeLatencyTraceRowInput,
): Promise<void> => {
  await client.bridgeLatencyTrace.create({
    data: {
      id: row.id,
      channel: row.channel,
      requestId: row.requestId,
      traceId: row.traceId,
      agentId: row.agentId,
      userId: row.userId,
      jsonRpcMethod: row.jsonRpcMethod,
      totalMs: row.totalMs,
      phasesSumMs: row.phasesSumMs,
      phasesSchemaVersion: row.phasesSchemaVersion,
      phasesMs: row.phasesMs as Prisma.InputJsonValue,
      outcome: row.outcome,
      httpStatus: row.httpStatus,
      errorCode: row.errorCode,
    },
  });
};

const performFlush = async (): Promise<void> => {
  if (batchDebounceTimer) {
    clearTimeout(batchDebounceTimer);
    batchDebounceTimer = null;
  }

  while (traceQueue.length > 0) {
    if (!(await canUseTraceTable())) {
      const dropped = traceQueue.length;
      traceMetrics.writesSkippedTableMissing += dropped;
      traceQueue.length = 0;
      return;
    }

    const batch = traceQueue.splice(0, env.bridgeLatencyTraceBatchMax);
    await trackPending(
      (async () => {
        try {
          if (env.bridgeLatencyTraceBatchMax <= 1) {
            await insertRow(prismaClient, batch[0] as BridgeLatencyTraceRowInput);
          } else {
            await prismaClient.$transaction(async (tx) => {
              for (const row of batch) {
                await insertRow(tx, row);
              }
            });
          }
          traceMetrics.writesSucceeded += batch.length;
        } catch (error: unknown) {
          if (isTraceTableMissing(error)) {
            tableState = "missing";
            traceMetrics.writesSkippedTableMissing += batch.length;
            if (!missingTableLogged) {
              logger.warn("bridge_latency_traces_table_missing", {
                message: toErrorMessage(error),
              });
              missingTableLogged = true;
            }
            return;
          }
          traceMetrics.writesFailed += batch.length;
          logger.warn("bridge_latency_trace_write_failed", { message: toErrorMessage(error) });
        }
      })(),
    );
  }
};

const queueFlush = (): void => {
  flushChain = flushChain
    .then(() => performFlush())
    .catch((error: unknown) => {
      logger.warn("bridge_latency_trace_flush_chain_failed", { message: toErrorMessage(error) });
    });
};

const scheduleDebouncedFlush = (): void => {
  if (batchDebounceTimer) {
    return;
  }
  batchDebounceTimer = setTimeout(() => {
    batchDebounceTimer = null;
    queueFlush();
  }, env.bridgeLatencyTraceBatchFlushMs);
  batchDebounceTimer.unref?.();
};

export const recordBridgeLatencyTracePersistSkipped = (): void => {
  traceMetrics.persistSkipped += 1;
};

export const applyPrivacyToBridgeLatencyRow = (
  row: BridgeLatencyTraceRowInput,
  cfg: { readonly redactUserId: boolean; readonly truncateRequestIdChars: number },
): BridgeLatencyTraceRowInput => {
  let requestId = row.requestId;
  if (cfg.truncateRequestIdChars > 0 && requestId.length > cfg.truncateRequestIdChars) {
    requestId = requestId.slice(0, cfg.truncateRequestIdChars);
  }
  return {
    ...row,
    requestId,
    userId: cfg.redactUserId ? null : row.userId,
  };
};

const applyBridgeLatencyTraceRowPrivacy = (
  row: BridgeLatencyTraceRowInput,
): BridgeLatencyTraceRowInput =>
  applyPrivacyToBridgeLatencyRow(row, {
    redactUserId: env.bridgeLatencyTraceRedactUserId,
    truncateRequestIdChars: env.bridgeLatencyTraceTruncateRequestIdChars,
  });

export const enqueueBridgeLatencyTrace = (row: BridgeLatencyTraceRowInput): void => {
  const warnMs = env.bridgeLatencyTracePhasesMismatchWarnMs;
  if (warnMs > 0) {
    const diff = Math.abs(row.totalMs - row.phasesSumMs);
    if (diff > warnMs) {
      traceMetrics.phasesMismatchTotal += 1;
      logger.debug("bridge_latency_trace_phases_mismatch", {
        diff,
        totalMs: row.totalMs,
        phasesSumMs: row.phasesSumMs,
        requestId: row.requestId,
        channel: row.channel,
      });
    }
  }

  const maxQ = env.bridgeLatencyTraceMaxQueue;
  if (maxQ > 0 && traceQueue.length >= maxQ) {
    traceMetrics.writesDroppedQueueFull += 1;
    return;
  }

  traceMetrics.enqueued += 1;

  const rowOut = applyBridgeLatencyTraceRowPrivacy(row);

  if (env.bridgeLatencyTraceBatchMax <= 1) {
    traceQueue.push(rowOut);
    queueFlush();
    return;
  }

  traceQueue.push(rowOut);
  if (traceQueue.length >= env.bridgeLatencyTraceBatchMax) {
    queueFlush();
  } else {
    scheduleDebouncedFlush();
  }
};

export const flushPendingBridgeLatencyTraces = async (): Promise<void> => {
  if (batchDebounceTimer) {
    clearTimeout(batchDebounceTimer);
    batchDebounceTimer = null;
  }
  queueFlush();
  await flushChain;
};

export const waitForBridgeLatencyTraceDrain = async (
  timeoutMs = 2_000,
): Promise<{ readonly drained: boolean; readonly pending: number }> => {
  const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(50, Math.floor(timeoutMs)) : 2_000;
  const deadlineMs = Date.now() + safeTimeoutMs;

  while (pendingOperations.size > 0 && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    drained: pendingOperations.size === 0,
    pending: pendingOperations.size,
  };
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

export const pruneBridgeLatencyTracesOlderThanDays = async (options?: {
  readonly defaultRetentionDays?: number;
  readonly relayRetentionDays?: number;
  readonly batchSize?: number;
}): Promise<number> => {
  traceMetrics.pruneRuns += 1;

  if (!(await canUseTraceTable())) {
    return 0;
  }

  const safeDefaultDays = Math.max(
    1,
    Math.floor(options?.defaultRetentionDays ?? env.bridgeLatencyTraceRetentionDays),
  );
  const safeRelayDays = Math.max(
    1,
    Math.floor(options?.relayRetentionDays ?? env.bridgeLatencyTraceRelayRetentionDays),
  );
  const safeBatchSize = Number.isFinite(options?.batchSize)
    ? Math.max(100, Math.floor(options?.batchSize ?? env.bridgeLatencyTracePruneBatchSize))
    : env.bridgeLatencyTracePruneBatchSize;
  const defaultCutoff = new Date(Date.now() - safeDefaultDays * 24 * 60 * 60 * 1000);
  const relayCutoff = new Date(Date.now() - safeRelayDays * 24 * 60 * 60 * 1000);

  return trackPending(
    (async () => {
      try {
        let totalDeleted = 0;

        while (true) {
          const rows = await prismaClient.$queryRaw<Array<{ deleted: number | bigint }>>`
            WITH candidate AS (
              SELECT id
              FROM bridge_latency_traces
              WHERE (
                (channel = 'relay' AND created_at < ${relayCutoff})
                OR (channel <> 'relay' AND created_at < ${defaultCutoff})
              )
              ORDER BY created_at ASC
              LIMIT ${safeBatchSize}
            ),
            deleted AS (
              DELETE FROM bridge_latency_traces target
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

        traceMetrics.pruneDeleted += totalDeleted;

        if (totalDeleted > 0) {
          logger.info("bridge_latency_traces_pruned", {
            deleted: totalDeleted,
            defaultRetentionDays: safeDefaultDays,
            relayRetentionDays: safeRelayDays,
            batchSize: safeBatchSize,
          });
        }

        return totalDeleted;
      } catch (error: unknown) {
        if (isTraceTableMissing(error)) {
          tableState = "missing";
          if (!missingTableLogged) {
            logger.warn("bridge_latency_traces_table_missing", { message: toErrorMessage(error) });
            missingTableLogged = true;
          }
        } else {
          logger.warn("bridge_latency_traces_prune_failed", { message: toErrorMessage(error) });
        }

        traceMetrics.pruneFailed += 1;
        return 0;
      }
    })(),
  );
};

export const startBridgeLatencyTraceRetentionScheduler = (options?: {
  readonly intervalMs?: number;
  readonly batchSize?: number;
}): void => {
  if (retentionTimer) {
    return;
  }

  const intervalMs =
    options?.intervalMs ?? env.bridgeLatencyTraceRetentionIntervalMinutes * 60 * 1000;
  const batchSize = options?.batchSize ?? env.bridgeLatencyTracePruneBatchSize;

  const run = (): void => {
    void pruneBridgeLatencyTracesOlderThanDays({ batchSize });
  };

  run();
  retentionTimer = setInterval(run, intervalMs);
  retentionTimer.unref?.();
};

export const stopBridgeLatencyTraceRetentionScheduler = (): void => {
  if (!retentionTimer) {
    return;
  }
  clearInterval(retentionTimer);
  retentionTimer = null;
};

export const getBridgeLatencyTraceMetricsSnapshot = (): {
  readonly enqueued: number;
  readonly writesSucceeded: number;
  readonly writesFailed: number;
  readonly writesSkippedTableMissing: number;
  readonly writesDroppedQueueFull: number;
  readonly persistSkipped: number;
  readonly phasesMismatchTotal: number;
  readonly pruneRuns: number;
  readonly pruneDeleted: number;
  readonly pruneFailed: number;
  readonly queuedRows: number;
} => ({
  enqueued: traceMetrics.enqueued,
  writesSucceeded: traceMetrics.writesSucceeded,
  writesFailed: traceMetrics.writesFailed,
  writesSkippedTableMissing: traceMetrics.writesSkippedTableMissing,
  writesDroppedQueueFull: traceMetrics.writesDroppedQueueFull,
  persistSkipped: traceMetrics.persistSkipped,
  phasesMismatchTotal: traceMetrics.phasesMismatchTotal,
  pruneRuns: traceMetrics.pruneRuns,
  pruneDeleted: traceMetrics.pruneDeleted,
  pruneFailed: traceMetrics.pruneFailed,
  queuedRows: traceQueue.length,
});

/** Test / teardown: drop queued rows and reset client-side table cache. */
export const resetBridgeLatencyTraceServiceForTests = (): void => {
  traceQueue.length = 0;
  if (batchDebounceTimer) {
    clearTimeout(batchDebounceTimer);
    batchDebounceTimer = null;
  }
  tableState = "unknown";
  missingTableLogged = false;
  traceMetrics.enqueued = 0;
  traceMetrics.writesSucceeded = 0;
  traceMetrics.writesFailed = 0;
  traceMetrics.writesSkippedTableMissing = 0;
  traceMetrics.writesDroppedQueueFull = 0;
  traceMetrics.persistSkipped = 0;
  traceMetrics.phasesMismatchTotal = 0;
  traceMetrics.pruneRuns = 0;
  traceMetrics.pruneDeleted = 0;
  traceMetrics.pruneFailed = 0;
  flushChain = Promise.resolve();
};
