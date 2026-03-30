import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import type { IEmailSender } from "../../domain/ports/email_sender.port";
import { prismaClient } from "../../infrastructure/database/prisma/client";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

type RegistrationOutboxKind = "admin_approval_request" | "user_pending_registration";

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

const enqueueRows = async (
  rows: Array<{ readonly kind: RegistrationOutboxKind; readonly payload: unknown }>,
): Promise<void> => {
  await prismaClient.$transaction(async (tx) => {
    for (const row of rows) {
      await tx.$executeRaw`
        INSERT INTO registration_email_outbox (
          id, kind, payload_json, attempts, available_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()},
          ${row.kind},
          ${JSON.stringify(row.payload)}::jsonb,
          0,
          NOW(),
          NOW(),
          NOW()
        )
      `;
    }
  });
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

const claimOutboxBatch = async (): Promise<RegistrationOutboxRow[]> => {
  const lockTimeoutSeconds = Math.max(1, Math.floor(env.registrationEmailOutboxLockTimeoutMs / 1000));

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
      if (row.kind !== "admin_approval_request" && row.kind !== "user_pending_registration") {
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

  if (!assertPendingPayload(row.payloadJson)) {
    await markFailed(row, "invalid user_pending_registration payload");
    return;
  }

  await emailSender.sendUserPendingRegistration(row.payloadJson);
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

  for (const row of rows) {
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
  }
};

export const flushRegistrationEmailOutbox = async (emailSender: IEmailSender): Promise<void> => {
  if (outboxWorkerRunning) {
    return;
  }
  outboxWorkerRunning = true;
  try {
    await trackPendingOutboxOp(
      (async () => {
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
