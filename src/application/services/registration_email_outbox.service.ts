import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type { IEmailSender } from "../../domain/ports/email_sender.port";
import { prismaClient } from "../../infrastructure/database/prisma/client";
import {
  MAINTENANCE_LOCK_IDS,
  runWithAdvisoryLock,
} from "../../infrastructure/database/advisory_lock";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

type RegistrationOutboxKind =
  | "admin_approval_request"
  | "user_pending_registration"
  | "client_registration_request_to_owner"
  | "client_access_request_to_owner";

interface RegistrationOutboxRow {
  readonly id: string;
  readonly kind: RegistrationOutboxKind;
  readonly payloadJson: Prisma.JsonValue;
  readonly attempts: number;
}

interface AdminApprovalPayload {
  readonly userEmail: string;
  readonly reviewToken: string;
}

interface UserPendingPayload {
  readonly email: string;
}

interface ClientRegistrationRequestToOwnerPayload {
  readonly ownerEmail: string;
  readonly clientEmail: string;
  readonly clientName: string;
  readonly clientLastName: string;
  readonly approvalToken: string;
}

interface ClientAccessRequestToOwnerPayload extends ClientRegistrationRequestToOwnerPayload {
  readonly agentId: string;
}

let outboxWorkerTimer: NodeJS.Timeout | null = null;
let outboxWorkerRunning = false;
let outboxTableState: "unknown" | "available" | "missing" = "unknown";
let outboxTableMissingLogged = false;
const pendingOutboxOps = new Set<Promise<unknown>>();

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isOutboxTableMissing = (error: unknown): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("registration_email_outbox") && message.includes("does not exist");
};

const trackPendingOutboxOp = async <T>(operation: Promise<T>): Promise<T> => {
  pendingOutboxOps.add(operation);
  try {
    return await operation;
  } finally {
    pendingOutboxOps.delete(operation);
  }
};

const canUseOutboxTable = async (): Promise<boolean> => {
  if (outboxTableState === "available") {
    return true;
  }
  if (outboxTableState === "missing") {
    return false;
  }

  try {
    const rows = await prismaClient.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public.registration_email_outbox') IS NOT NULL AS "exists"
    `;
    const exists = rows[0]?.exists === true;
    outboxTableState = exists ? "available" : "missing";

    if (!exists && !outboxTableMissingLogged) {
      logger.warn("registration_email_outbox_table_missing", {
        message: "registration_email_outbox table not found",
      });
      outboxTableMissingLogged = true;
    }

    return exists;
  } catch (error: unknown) {
    logger.warn("registration_email_outbox_probe_failed", { message: toErrorMessage(error) });
    return false;
  }
};

const assertAdminPayload = (payload: unknown): payload is AdminApprovalPayload => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const p = payload as Record<string, unknown>;
  return typeof p.userEmail === "string" && typeof p.reviewToken === "string";
};

const assertPendingPayload = (payload: unknown): payload is UserPendingPayload => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const p = payload as Record<string, unknown>;
  return typeof p.email === "string";
};

const assertClientRegistrationRequestToOwnerPayload = (
  payload: unknown,
): payload is ClientRegistrationRequestToOwnerPayload => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const p = payload as Record<string, unknown>;
  return (
    typeof p.ownerEmail === "string" &&
    typeof p.clientEmail === "string" &&
    typeof p.clientName === "string" &&
    typeof p.clientLastName === "string" &&
    typeof p.approvalToken === "string"
  );
};

const assertClientAccessRequestToOwnerPayload = (
  payload: unknown,
): payload is ClientAccessRequestToOwnerPayload => {
  if (!assertClientRegistrationRequestToOwnerPayload(payload)) {
    return false;
  }
  return typeof (payload as unknown as Record<string, unknown>).agentId === "string";
};

const enqueueRows = async (
  rows: Array<{ readonly kind: RegistrationOutboxKind; readonly payload: unknown }>,
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }

  const values = rows.map(
    (row) => Prisma.sql`(
      ${randomUUID()},
      ${row.kind},
      ${JSON.stringify(row.payload)}::jsonb,
      0,
      NOW(),
      NOW(),
      NOW()
    )`,
  );

  await prismaClient.$executeRaw`
    INSERT INTO registration_email_outbox (
      id, kind, payload_json, attempts, available_at, created_at, updated_at
    ) VALUES ${Prisma.join(values)}
  `;
};

export const enqueueRegistrationApprovalEmails = async (input: {
  readonly userEmail: string;
  readonly reviewToken: string;
}): Promise<boolean> => {
  if (!env.registrationEmailOutboxEnabled || env.nodeEnv === "test") {
    return false;
  }

  if (!(await canUseOutboxTable())) {
    return false;
  }

  try {
    await trackPendingOutboxOp(
      enqueueRows([
        {
          kind: "admin_approval_request",
          payload: {
            userEmail: input.userEmail,
            reviewToken: input.reviewToken,
          } satisfies AdminApprovalPayload,
        },
        {
          kind: "user_pending_registration",
          payload: {
            email: input.userEmail,
          } satisfies UserPendingPayload,
        },
      ]),
    );
    return true;
  } catch (error: unknown) {
    if (isOutboxTableMissing(error)) {
      outboxTableState = "missing";
      if (!outboxTableMissingLogged) {
        logger.warn("registration_email_outbox_table_missing", {
          message: toErrorMessage(error),
        });
        outboxTableMissingLogged = true;
      }
      return false;
    }

    logger.warn("registration_email_outbox_enqueue_failed", {
      message: toErrorMessage(error),
    });
    return false;
  }
};

export const enqueueClientRegistrationApprovalEmail = async (input: {
  readonly ownerEmail: string;
  readonly clientEmail: string;
  readonly clientName: string;
  readonly clientLastName: string;
  readonly approvalToken: string;
}): Promise<boolean> => {
  if (!env.registrationEmailOutboxEnabled || env.nodeEnv === "test") {
    return false;
  }

  if (!(await canUseOutboxTable())) {
    return false;
  }

  try {
    await trackPendingOutboxOp(
      enqueueRows([
        {
          kind: "client_registration_request_to_owner",
          payload: {
            ownerEmail: input.ownerEmail,
            clientEmail: input.clientEmail,
            clientName: input.clientName,
            clientLastName: input.clientLastName,
            approvalToken: input.approvalToken,
          } satisfies ClientRegistrationRequestToOwnerPayload,
        },
      ]),
    );
    return true;
  } catch (error: unknown) {
    if (isOutboxTableMissing(error)) {
      outboxTableState = "missing";
      if (!outboxTableMissingLogged) {
        logger.warn("registration_email_outbox_table_missing", {
          message: toErrorMessage(error),
        });
        outboxTableMissingLogged = true;
      }
      return false;
    }

    logger.warn("client_registration_email_outbox_enqueue_failed", {
      message: toErrorMessage(error),
    });
    return false;
  }
};

export const enqueueClientAccessApprovalEmails = async (
  inputs: ReadonlyArray<{
    readonly ownerEmail: string;
    readonly clientEmail: string;
    readonly clientName: string;
    readonly clientLastName: string;
    readonly agentId: string;
    readonly approvalToken: string;
  }>,
): Promise<boolean> => {
  if (!env.registrationEmailOutboxEnabled || env.nodeEnv === "test" || inputs.length === 0) {
    return false;
  }

  if (!(await canUseOutboxTable())) {
    return false;
  }

  try {
    await trackPendingOutboxOp(
      enqueueRows(
        inputs.map((input) => ({
          kind: "client_access_request_to_owner",
          payload: {
            ownerEmail: input.ownerEmail,
            clientEmail: input.clientEmail,
            clientName: input.clientName,
            clientLastName: input.clientLastName,
            agentId: input.agentId,
            approvalToken: input.approvalToken,
          } satisfies ClientAccessRequestToOwnerPayload,
        })),
      ),
    );
    return true;
  } catch (error: unknown) {
    if (isOutboxTableMissing(error)) {
      outboxTableState = "missing";
      if (!outboxTableMissingLogged) {
        logger.warn("registration_email_outbox_table_missing", {
          message: toErrorMessage(error),
        });
        outboxTableMissingLogged = true;
      }
      return false;
    }

    logger.warn("client_access_email_outbox_enqueue_failed", {
      message: toErrorMessage(error),
    });
    return false;
  }
};

const claimOutboxBatch = async (): Promise<RegistrationOutboxRow[]> => {
  const lockTimeoutSeconds = Math.max(
    1,
    Math.floor(env.registrationEmailOutboxLockTimeoutMs / 1000),
  );

  const rows = await prismaClient.$queryRaw<
    Array<{ id: string; kind: string; payload_json: Prisma.JsonValue; attempts: number }>
  >`
    WITH candidate AS (
      SELECT id
      FROM registration_email_outbox
      WHERE
        attempts < ${env.registrationEmailOutboxMaxAttempts}
        AND available_at <= NOW()
        AND (
          locked_at IS NULL
          OR locked_at < NOW() - (${lockTimeoutSeconds} * INTERVAL '1 second')
        )
      ORDER BY available_at ASC, created_at ASC
      LIMIT ${env.registrationEmailOutboxBatchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE registration_email_outbox outbox
    SET
      locked_at = NOW(),
      updated_at = NOW()
    FROM candidate
    WHERE outbox.id = candidate.id
    RETURNING outbox.id, outbox.kind, outbox.payload_json, outbox.attempts
  `;

  return rows
    .map((row): RegistrationOutboxRow | null => {
      if (
        row.kind !== "admin_approval_request" &&
        row.kind !== "user_pending_registration" &&
        row.kind !== "client_registration_request_to_owner" &&
        row.kind !== "client_access_request_to_owner"
      ) {
        return null;
      }

      return {
        id: row.id,
        kind: row.kind,
        payloadJson: row.payload_json,
        attempts: row.attempts,
      } satisfies RegistrationOutboxRow;
    })
    .filter((row): row is RegistrationOutboxRow => row !== null);
};

const computeBackoffMs = (attempts: number): number => {
  const exp = Math.min(6, Math.max(0, attempts - 1));
  return env.registrationEmailOutboxRetryBaseDelayMs * 2 ** exp;
};

const markDelivered = async (id: string): Promise<void> => {
  await prismaClient.$executeRaw`
    DELETE FROM registration_email_outbox
    WHERE id = ${id}
  `;
};

const markFailed = async (row: RegistrationOutboxRow, errorMessage: string): Promise<void> => {
  const nextAttempts = row.attempts + 1;
  const shouldDeadLetter = nextAttempts >= env.registrationEmailOutboxMaxAttempts;
  const backoffMs = computeBackoffMs(nextAttempts);

  if (shouldDeadLetter) {
    await prismaClient.$executeRaw`
      UPDATE registration_email_outbox
      SET
        attempts = ${nextAttempts},
        last_error = ${`max_attempts_reached: ${errorMessage}`},
        locked_at = NULL,
        updated_at = NOW()
      WHERE id = ${row.id}
    `;
    return;
  }

  await prismaClient.$executeRaw`
    UPDATE registration_email_outbox
    SET
      attempts = ${nextAttempts},
      last_error = ${errorMessage},
      locked_at = NULL,
      available_at = NOW() + (${backoffMs} * INTERVAL '1 millisecond'),
      updated_at = NOW()
    WHERE id = ${row.id}
  `;
};

const deliverRow = async (emailSender: IEmailSender, row: RegistrationOutboxRow): Promise<void> => {
  if (row.kind === "admin_approval_request") {
    if (!assertAdminPayload(row.payloadJson)) {
      await markFailed(row, "invalid admin_approval_request payload");
      return;
    }

    await emailSender.sendAdminApprovalRequest(row.payloadJson);
    await markDelivered(row.id);
    return;
  }

  if (row.kind === "user_pending_registration") {
    if (!assertPendingPayload(row.payloadJson)) {
      await markFailed(row, "invalid user_pending_registration payload");
      return;
    }
    await emailSender.sendUserPendingRegistration(row.payloadJson);
    await markDelivered(row.id);
    return;
  }

  if (row.kind === "client_access_request_to_owner") {
    if (!assertClientAccessRequestToOwnerPayload(row.payloadJson)) {
      await markFailed(row, "invalid client_access_request_to_owner payload");
      return;
    }

    await emailSender.sendClientAccessRequestToOwner(row.payloadJson);
    await markDelivered(row.id);
    return;
  }

  if (!assertClientRegistrationRequestToOwnerPayload(row.payloadJson)) {
    await markFailed(row, "invalid client_registration_request_to_owner payload");
    return;
  }

  await emailSender.sendClientRegistrationRequestToOwner(row.payloadJson);
  await markDelivered(row.id);
};

const processOutboxBatch = async (emailSender: IEmailSender): Promise<void> => {
  if (!(await canUseOutboxTable())) {
    return;
  }

  const rows = await claimOutboxBatch();
  if (rows.length === 0) {
    return;
  }

  const processRow = async (row: RegistrationOutboxRow): Promise<void> => {
    try {
      await deliverRow(emailSender, row);
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      await markFailed(row, message);
      logger.warn("registration_email_outbox_delivery_failed", {
        outboxId: row.id,
        kind: row.kind,
        attempts: row.attempts + 1,
        message,
      });
    }
  };

  /**
   * Worker concurrency is bounded by the env knob (default 4 for legacy
   * single-replica behaviour). Generous profile sets 8+ when the SMTP
   * provider and connection pool tolerate parallel sends. Never exceed
   * `rows.length` so a small batch does not start more workers than rows.
   */
  const concurrency = Math.max(
    1,
    Math.min(env.registrationEmailOutboxWorkerConcurrency, rows.length),
  );
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < rows.length) {
        const row = rows[nextIndex];
        nextIndex += 1;
        if (row) {
          await processRow(row);
        }
      }
    }),
  );
};

export const flushRegistrationEmailOutbox = async (emailSender: IEmailSender): Promise<void> => {
  if (outboxWorkerRunning) {
    return;
  }
  outboxWorkerRunning = true;
  try {
    await trackPendingOutboxOp(
      (async () => {
        await maybeLogRegistrationEmailOutboxHealth();
        await processOutboxBatch(emailSender);
      })(),
    );
  } catch (error: unknown) {
    if (isOutboxTableMissing(error)) {
      outboxTableState = "missing";
      if (!outboxTableMissingLogged) {
        logger.warn("registration_email_outbox_table_missing", {
          message: toErrorMessage(error),
        });
        outboxTableMissingLogged = true;
      }
      return;
    }
    logger.warn("registration_email_outbox_flush_failed", { message: toErrorMessage(error) });
  } finally {
    outboxWorkerRunning = false;
  }
};

export const startRegistrationEmailOutboxWorker = (emailSender: IEmailSender): void => {
  if (outboxWorkerTimer || !env.registrationEmailOutboxEnabled || env.nodeEnv === "test") {
    return;
  }

  const tick = (): void => {
    void flushRegistrationEmailOutbox(emailSender);
  };

  tick();
  outboxWorkerTimer = setInterval(tick, env.registrationEmailOutboxPollIntervalMs);
  outboxWorkerTimer.unref?.();
};

export const stopRegistrationEmailOutboxWorker = (): void => {
  if (!outboxWorkerTimer) {
    return;
  }
  clearInterval(outboxWorkerTimer);
  outboxWorkerTimer = null;
};

let outboxDeadLetterPruneTimer: NodeJS.Timeout | null = null;

/** Throttle aggregate outbox health logs (read-only) for operators / metrics pipelines. */
const OUTBOX_HEALTH_LOG_INTERVAL_MS = 10 * 60 * 1000;
let lastOutboxHealthLogAt = 0;

const maybeLogRegistrationEmailOutboxHealth = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastOutboxHealthLogAt < OUTBOX_HEALTH_LOG_INTERVAL_MS) {
    return;
  }
  lastOutboxHealthLogAt = now;

  if (!(await canUseOutboxTable())) {
    return;
  }

  const maxAttempts = env.registrationEmailOutboxMaxAttempts;
  try {
    const rows = await prismaClient.$queryRaw<
      Array<{
        total: bigint;
        retrying_with_error: bigint;
        dead_lettered: bigint;
        high_attempts: bigint;
      }>
    >`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (
          WHERE last_error IS NOT NULL AND attempts < ${maxAttempts}
        )::bigint AS retrying_with_error,
        COUNT(*) FILTER (WHERE attempts >= ${maxAttempts})::bigint AS dead_lettered,
        COUNT(*) FILTER (WHERE attempts >= ${maxAttempts} - 1 AND attempts < ${maxAttempts})::bigint AS high_attempts
      FROM registration_email_outbox
    `;
    const row = rows[0];
    if (!row) {
      return;
    }

    const total = Number(row.total);
    const retryingWithError = Number(row.retrying_with_error);
    const deadLettered = Number(row.dead_lettered);
    const highAttempts = Number(row.high_attempts);

    if (total === 0) {
      return;
    }

    const backlogConcerning = total >= 100;
    const hasErrors = retryingWithError > 0 || deadLettered > 0 || highAttempts > 0;

    if (!hasErrors && !backlogConcerning) {
      return;
    }

    logger.warn("registration_email_outbox_health", {
      message:
        "Registration email outbox shows retries, dead letters, or a large backlog — check SMTP and pending registrations.",
      total,
      retryingWithError,
      deadLettered,
      highAttempts,
      maxAttempts,
      backlogConcerning,
    });
  } catch (error: unknown) {
    if (isOutboxTableMissing(error)) {
      outboxTableState = "missing";
      return;
    }
    logger.warn("registration_email_outbox_health_probe_failed", {
      message: toErrorMessage(error),
    });
  }
};

const outboxPruneMetrics = {
  pruneRuns: 0,
  pruneDeleted: 0,
  pruneFailed: 0,
};

/**
 * Permanently deletes outbox rows that hit `MAX_ATTEMPTS` (dead-lettered) and
 * have been sitting that way for at least `retentionDays` days. Without this
 * cleanup, dead rows accumulate forever — they're excluded from the claim CTE
 * by the `attempts < MAX_ATTEMPTS` filter but still occupy disk and bloat
 * indexes.
 */
export const pruneRegistrationOutboxDeadLetters = async (
  retentionDays: number = env.registrationEmailOutboxDeadLetterRetentionDays,
): Promise<number> => {
  if (retentionDays <= 0) {
    return 0;
  }

  outboxPruneMetrics.pruneRuns += 1;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const maxAttempts = env.registrationEmailOutboxMaxAttempts;

  return trackPendingOutboxOp(
    (async () => {
      try {
        const result = await prismaClient.$executeRaw`
          DELETE FROM registration_email_outbox
          WHERE attempts >= ${maxAttempts}
            AND updated_at < ${cutoff}
        `;
        const deleted = typeof result === "number" ? result : 0;
        outboxPruneMetrics.pruneDeleted += deleted;
        if (deleted > 0) {
          logger.info("registration_email_outbox_dead_letters_pruned", {
            deleted,
            retentionDays,
            maxAttempts,
          });
        }
        return deleted;
      } catch (error: unknown) {
        if (isOutboxTableMissing(error)) {
          outboxTableState = "missing";
          if (!outboxTableMissingLogged) {
            logger.warn("registration_email_outbox_table_missing", {
              message: toErrorMessage(error),
            });
            outboxTableMissingLogged = true;
          }
          return 0;
        }
        outboxPruneMetrics.pruneFailed += 1;
        logger.warn("registration_email_outbox_dead_letter_prune_failed", {
          message: toErrorMessage(error),
        });
        return 0;
      }
    })(),
  );
};

export const startRegistrationEmailOutboxDeadLetterScheduler = (): void => {
  if (outboxDeadLetterPruneTimer) {
    return;
  }
  if (env.registrationEmailOutboxDeadLetterRetentionDays <= 0) {
    return;
  }
  if (env.nodeEnv === "test") {
    return;
  }

  const intervalMs = env.registrationEmailOutboxDeadLetterPruneIntervalMinutes * 60 * 1000;

  // Multi-replica safe: the advisory lock ensures only one replica runs the
  // DELETE per interval, even if all replicas tick concurrently.
  const run = (): void => {
    void runWithAdvisoryLock(
      MAINTENANCE_LOCK_IDS.registrationOutboxDeadLetterPrune,
      "registration_outbox_dead_letter_prune",
      () => pruneRegistrationOutboxDeadLetters(),
    );
  };

  run();
  outboxDeadLetterPruneTimer = setInterval(run, intervalMs);
  outboxDeadLetterPruneTimer.unref?.();
};

export const stopRegistrationEmailOutboxDeadLetterScheduler = (): void => {
  if (!outboxDeadLetterPruneTimer) {
    return;
  }
  clearInterval(outboxDeadLetterPruneTimer);
  outboxDeadLetterPruneTimer = null;
};

export const getRegistrationEmailOutboxPruneMetricsSnapshot = (): {
  readonly pruneRuns: number;
  readonly pruneDeleted: number;
  readonly pruneFailed: number;
} => ({
  pruneRuns: outboxPruneMetrics.pruneRuns,
  pruneDeleted: outboxPruneMetrics.pruneDeleted,
  pruneFailed: outboxPruneMetrics.pruneFailed,
});

export const waitForRegistrationEmailOutboxDrain = async (
  timeoutMs = 2_000,
): Promise<{ readonly drained: boolean; readonly pending: number }> => {
  const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(50, Math.floor(timeoutMs)) : 2_000;
  const deadlineMs = Date.now() + safeTimeoutMs;

  while (pendingOutboxOps.size > 0 && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    drained: pendingOutboxOps.size === 0,
    pending: pendingOutboxOps.size,
  };
};
