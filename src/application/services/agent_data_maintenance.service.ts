import { prismaClient } from "../../infrastructure/database/prisma/client";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";
import { clientAgentAccessExpiredDecisionReason } from "./client_agent_access_decision_reasons";

interface AgentProfileDataPruneResult {
  readonly revisionsDeleted: number;
  readonly idempotencyDeleted: number;
}

interface ClientAgentAccessExpirySweepResult {
  readonly requestsExpired: number;
  readonly tokensDeleted: number;
}

type TableState = "unknown" | "available" | "missing";

const agentDataMaintenanceMetrics = {
  profilePruneRuns: 0,
  profileRevisionsDeleted: 0,
  profileIdempotencyDeleted: 0,
  profilePruneFailed: 0,
  clientAccessExpiryRuns: 0,
  clientAccessRequestsExpired: 0,
  clientAccessTokensDeleted: 0,
  clientAccessExpiryFailed: 0,
};

let profileRetentionTimer: NodeJS.Timeout | null = null;
let clientAccessExpiryTimer: NodeJS.Timeout | null = null;
let profileTableState: TableState = "unknown";
let clientAccessTableState: TableState = "unknown";
let profileTableMissingLogged = false;
let clientAccessTableMissingLogged = false;
const pendingOperations = new Set<Promise<unknown>>();

const trackPendingOperation = async <T>(operation: Promise<T>): Promise<T> => {
  pendingOperations.add(operation);
  try {
    return await operation;
  } finally {
    pendingOperations.delete(operation);
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

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissingTableError = (error: unknown, tableNames: readonly string[]): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  const mentionsMissingTable =
    message.includes("does not exist") || message.includes("undefined table");
  return mentionsMissingTable && tableNames.some((tableName) => message.includes(tableName));
};

const isProfileTableMissingError = (error: unknown): boolean =>
  isMissingTableError(error, ["agent_profile_revisions", "agent_profile_write_idempotencies"]);

const isClientAccessTableMissingError = (error: unknown): boolean =>
  isMissingTableError(error, [
    "client_agent_access_requests",
    "client_agent_access_approval_tokens",
  ]);

const canUseProfileTables = async (): Promise<boolean> => {
  if (profileTableState === "available") {
    return true;
  }
  if (profileTableState === "missing") {
    return false;
  }

  try {
    const rows = await prismaClient.$queryRaw<
      Array<{ revisionsExists: boolean; idempotenciesExists: boolean }>
    >`
      SELECT
        to_regclass('public.agent_profile_revisions') IS NOT NULL AS "revisionsExists",
        to_regclass('public.agent_profile_write_idempotencies') IS NOT NULL AS "idempotenciesExists"
    `;
    const exists = Boolean(rows[0]?.revisionsExists && rows[0]?.idempotenciesExists);
    profileTableState = exists ? "available" : "missing";
    if (!exists && !profileTableMissingLogged) {
      logger.warn("agent_profile_maintenance_tables_missing");
      profileTableMissingLogged = true;
    }
    return exists;
  } catch (error: unknown) {
    if (isProfileTableMissingError(error)) {
      profileTableState = "missing";
      if (!profileTableMissingLogged) {
        logger.warn("agent_profile_maintenance_tables_missing", {
          message: toErrorMessage(error),
        });
        profileTableMissingLogged = true;
      }
      return false;
    }
    throw error;
  }
};

const canUseClientAccessTables = async (): Promise<boolean> => {
  if (clientAccessTableState === "available") {
    return true;
  }
  if (clientAccessTableState === "missing") {
    return false;
  }

  try {
    const rows = await prismaClient.$queryRaw<
      Array<{ requestsExists: boolean; tokensExists: boolean }>
    >`
      SELECT
        to_regclass('public.client_agent_access_requests') IS NOT NULL AS "requestsExists",
        to_regclass('public.client_agent_access_approval_tokens') IS NOT NULL AS "tokensExists"
    `;
    const exists = Boolean(rows[0]?.requestsExists && rows[0]?.tokensExists);
    clientAccessTableState = exists ? "available" : "missing";
    if (!exists && !clientAccessTableMissingLogged) {
      logger.warn("client_agent_access_expiry_tables_missing");
      clientAccessTableMissingLogged = true;
    }
    return exists;
  } catch (error: unknown) {
    if (isClientAccessTableMissingError(error)) {
      clientAccessTableState = "missing";
      if (!clientAccessTableMissingLogged) {
        logger.warn("client_agent_access_expiry_tables_missing", {
          message: toErrorMessage(error),
        });
        clientAccessTableMissingLogged = true;
      }
      return false;
    }
    throw error;
  }
};

export const pruneAgentProfileData = async (options?: {
  readonly revisionRetentionDays?: number;
  readonly idempotencyRetentionDays?: number;
  readonly batchSize?: number;
}): Promise<AgentProfileDataPruneResult> => {
  agentDataMaintenanceMetrics.profilePruneRuns += 1;

  if (!(await canUseProfileTables())) {
    return { revisionsDeleted: 0, idempotencyDeleted: 0 };
  }

  const safeRevisionRetentionDays = Math.max(
    1,
    Math.floor(options?.revisionRetentionDays ?? env.agentProfileRevisionRetentionDays),
  );
  const safeIdempotencyRetentionDays = Math.max(
    1,
    Math.floor(options?.idempotencyRetentionDays ?? env.agentProfileIdempotencyRetentionDays),
  );
  const safeBatchSize = Number.isFinite(options?.batchSize)
    ? Math.max(100, Math.floor(options?.batchSize ?? env.agentProfileMaintenancePruneBatchSize))
    : env.agentProfileMaintenancePruneBatchSize;
  const revisionCutoff = new Date(Date.now() - safeRevisionRetentionDays * 24 * 60 * 60 * 1000);
  const idempotencyCutoff = new Date(
    Date.now() - safeIdempotencyRetentionDays * 24 * 60 * 60 * 1000,
  );

  return trackPendingOperation(
    (async (): Promise<AgentProfileDataPruneResult> => {
      try {
        let revisionsDeleted = 0;
        let idempotencyDeleted = 0;

        while (true) {
          const rows = await prismaClient.$queryRaw<Array<{ deleted: number | bigint }>>`
            WITH candidate AS (
              SELECT id
              FROM agent_profile_revisions
              WHERE created_at < ${revisionCutoff}
              ORDER BY created_at ASC
              LIMIT ${safeBatchSize}
            ),
            deleted AS (
              DELETE FROM agent_profile_revisions target
              USING candidate
              WHERE target.id = candidate.id
              RETURNING target.id
            )
            SELECT COUNT(*)::int AS deleted FROM deleted
          `;
          const deletedInBatch = toNumber(rows[0]?.deleted ?? 0);
          revisionsDeleted += deletedInBatch;
          if (deletedInBatch < safeBatchSize) {
            break;
          }
        }

        while (true) {
          const rows = await prismaClient.$queryRaw<Array<{ deleted: number | bigint }>>`
            WITH candidate AS (
              SELECT id
              FROM agent_profile_write_idempotencies
              WHERE created_at < ${idempotencyCutoff}
              ORDER BY created_at ASC
              LIMIT ${safeBatchSize}
            ),
            deleted AS (
              DELETE FROM agent_profile_write_idempotencies target
              USING candidate
              WHERE target.id = candidate.id
              RETURNING target.id
            )
            SELECT COUNT(*)::int AS deleted FROM deleted
          `;
          const deletedInBatch = toNumber(rows[0]?.deleted ?? 0);
          idempotencyDeleted += deletedInBatch;
          if (deletedInBatch < safeBatchSize) {
            break;
          }
        }

        agentDataMaintenanceMetrics.profileRevisionsDeleted += revisionsDeleted;
        agentDataMaintenanceMetrics.profileIdempotencyDeleted += idempotencyDeleted;

        if (revisionsDeleted > 0 || idempotencyDeleted > 0) {
          logger.info("agent_profile_data_pruned", {
            revisionsDeleted,
            idempotencyDeleted,
            revisionRetentionDays: safeRevisionRetentionDays,
            idempotencyRetentionDays: safeIdempotencyRetentionDays,
            batchSize: safeBatchSize,
          });
        }

        return { revisionsDeleted, idempotencyDeleted };
      } catch (error: unknown) {
        if (isProfileTableMissingError(error)) {
          profileTableState = "missing";
          if (!profileTableMissingLogged) {
            logger.warn("agent_profile_maintenance_tables_missing", {
              message: toErrorMessage(error),
            });
            profileTableMissingLogged = true;
          }
        } else {
          logger.warn("agent_profile_data_prune_failed", { message: toErrorMessage(error) });
        }
        agentDataMaintenanceMetrics.profilePruneFailed += 1;
        return { revisionsDeleted: 0, idempotencyDeleted: 0 };
      }
    })(),
  );
};

export const sweepExpiredClientAgentAccessData = async (options?: {
  readonly batchSize?: number;
}): Promise<ClientAgentAccessExpirySweepResult> => {
  agentDataMaintenanceMetrics.clientAccessExpiryRuns += 1;

  if (!(await canUseClientAccessTables())) {
    return { requestsExpired: 0, tokensDeleted: 0 };
  }

  const safeBatchSize = Number.isFinite(options?.batchSize)
    ? Math.max(100, Math.floor(options?.batchSize ?? env.clientAgentAccessExpirySweepBatchSize))
    : env.clientAgentAccessExpirySweepBatchSize;

  return trackPendingOperation(
    (async (): Promise<ClientAgentAccessExpirySweepResult> => {
      try {
        let requestsExpired = 0;
        let tokensDeleted = 0;
        const sweepCutoff = new Date();

        while (true) {
          const batch = await prismaClient.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ expired: number | bigint; deleted: number | bigint }>
            >`
              WITH candidate AS (
                SELECT request.id AS request_id, token.id AS token_id
                FROM client_agent_access_requests request
                INNER JOIN client_agent_access_approval_tokens token
                  ON token.request_id = request.id
                WHERE request.status = 'pending'
                  AND token.expires_at < ${sweepCutoff}
                ORDER BY token.expires_at ASC
                LIMIT ${safeBatchSize}
              ),
              updated AS (
                UPDATE client_agent_access_requests target
                SET status = 'expired',
                    decided_at = COALESCE(target.decided_at, ${sweepCutoff}),
                    decision_reason = COALESCE(
                      target.decision_reason,
                      ${clientAgentAccessExpiredDecisionReason}
                    ),
                    updated_at = ${sweepCutoff}
                FROM candidate
                WHERE target.id = candidate.request_id
                RETURNING target.id
              ),
              deleted AS (
                DELETE FROM client_agent_access_approval_tokens target
                USING candidate
                WHERE target.id = candidate.token_id
                RETURNING target.id
              )
              SELECT
                (SELECT COUNT(*)::int FROM updated) AS expired,
                (SELECT COUNT(*)::int FROM deleted) AS deleted
            `;
            return rows[0] ?? { expired: 0, deleted: 0 };
          });
          const expiredInBatch = toNumber(batch.expired);
          const deletedInBatch = toNumber(batch.deleted);
          requestsExpired += expiredInBatch;
          tokensDeleted += deletedInBatch;
          if (expiredInBatch < safeBatchSize) {
            break;
          }
        }

        while (true) {
          const rows = await prismaClient.$queryRaw<Array<{ deleted: number | bigint }>>`
            WITH candidate AS (
              SELECT id
              FROM client_agent_access_approval_tokens
              WHERE expires_at < ${sweepCutoff}
              ORDER BY expires_at ASC
              LIMIT ${safeBatchSize}
            ),
            deleted AS (
              DELETE FROM client_agent_access_approval_tokens target
              USING candidate
              WHERE target.id = candidate.id
              RETURNING target.id
            )
            SELECT COUNT(*)::int AS deleted FROM deleted
          `;
          const deletedInBatch = toNumber(rows[0]?.deleted ?? 0);
          tokensDeleted += deletedInBatch;
          if (deletedInBatch < safeBatchSize) {
            break;
          }
        }

        agentDataMaintenanceMetrics.clientAccessRequestsExpired += requestsExpired;
        agentDataMaintenanceMetrics.clientAccessTokensDeleted += tokensDeleted;

        if (requestsExpired > 0 || tokensDeleted > 0) {
          logger.info("client_agent_access_expiry_swept", {
            requestsExpired,
            tokensDeleted,
            batchSize: safeBatchSize,
          });
        }

        return { requestsExpired, tokensDeleted };
      } catch (error: unknown) {
        if (isClientAccessTableMissingError(error)) {
          clientAccessTableState = "missing";
          if (!clientAccessTableMissingLogged) {
            logger.warn("client_agent_access_expiry_tables_missing", {
              message: toErrorMessage(error),
            });
            clientAccessTableMissingLogged = true;
          }
        } else {
          logger.warn("client_agent_access_expiry_sweep_failed", {
            message: toErrorMessage(error),
          });
        }
        agentDataMaintenanceMetrics.clientAccessExpiryFailed += 1;
        return { requestsExpired: 0, tokensDeleted: 0 };
      }
    })(),
  );
};

export const startAgentProfileMaintenanceScheduler = (options?: {
  readonly intervalMs?: number;
  readonly batchSize?: number;
}): void => {
  if (profileRetentionTimer) {
    return;
  }

  const intervalMs = options?.intervalMs ?? env.agentProfileMaintenanceIntervalMinutes * 60 * 1000;
  const batchSize = options?.batchSize ?? env.agentProfileMaintenancePruneBatchSize;

  const run = (): void => {
    void pruneAgentProfileData({ batchSize });
  };

  run();
  profileRetentionTimer = setInterval(run, intervalMs);
  profileRetentionTimer.unref?.();
};

export const stopAgentProfileMaintenanceScheduler = (): void => {
  if (!profileRetentionTimer) {
    return;
  }
  clearInterval(profileRetentionTimer);
  profileRetentionTimer = null;
};

export const startClientAgentAccessExpiryScheduler = (options?: {
  readonly intervalMs?: number;
  readonly batchSize?: number;
}): void => {
  if (clientAccessExpiryTimer) {
    return;
  }

  const intervalMs =
    options?.intervalMs ?? env.clientAgentAccessExpirySweepIntervalMinutes * 60 * 1000;
  const batchSize = options?.batchSize ?? env.clientAgentAccessExpirySweepBatchSize;

  const run = (): void => {
    void sweepExpiredClientAgentAccessData({ batchSize });
  };

  run();
  clientAccessExpiryTimer = setInterval(run, intervalMs);
  clientAccessExpiryTimer.unref?.();
};

export const stopClientAgentAccessExpiryScheduler = (): void => {
  if (!clientAccessExpiryTimer) {
    return;
  }
  clearInterval(clientAccessExpiryTimer);
  clientAccessExpiryTimer = null;
};

export const waitForAgentDataMaintenanceDrain = async (
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

export const getAgentDataMaintenanceMetricsSnapshot = (): {
  readonly profilePruneRuns: number;
  readonly profileRevisionsDeleted: number;
  readonly profileIdempotencyDeleted: number;
  readonly profilePruneFailed: number;
  readonly clientAccessExpiryRuns: number;
  readonly clientAccessRequestsExpired: number;
  readonly clientAccessTokensDeleted: number;
  readonly clientAccessExpiryFailed: number;
  readonly pendingOperations: number;
} => ({
  profilePruneRuns: agentDataMaintenanceMetrics.profilePruneRuns,
  profileRevisionsDeleted: agentDataMaintenanceMetrics.profileRevisionsDeleted,
  profileIdempotencyDeleted: agentDataMaintenanceMetrics.profileIdempotencyDeleted,
  profilePruneFailed: agentDataMaintenanceMetrics.profilePruneFailed,
  clientAccessExpiryRuns: agentDataMaintenanceMetrics.clientAccessExpiryRuns,
  clientAccessRequestsExpired: agentDataMaintenanceMetrics.clientAccessRequestsExpired,
  clientAccessTokensDeleted: agentDataMaintenanceMetrics.clientAccessTokensDeleted,
  clientAccessExpiryFailed: agentDataMaintenanceMetrics.clientAccessExpiryFailed,
  pendingOperations: pendingOperations.size,
});

export const resetAgentDataMaintenanceServiceForTests = (): void => {
  stopAgentProfileMaintenanceScheduler();
  stopClientAgentAccessExpiryScheduler();
  profileTableState = "unknown";
  clientAccessTableState = "unknown";
  profileTableMissingLogged = false;
  clientAccessTableMissingLogged = false;
  agentDataMaintenanceMetrics.profilePruneRuns = 0;
  agentDataMaintenanceMetrics.profileRevisionsDeleted = 0;
  agentDataMaintenanceMetrics.profileIdempotencyDeleted = 0;
  agentDataMaintenanceMetrics.profilePruneFailed = 0;
  agentDataMaintenanceMetrics.clientAccessExpiryRuns = 0;
  agentDataMaintenanceMetrics.clientAccessRequestsExpired = 0;
  agentDataMaintenanceMetrics.clientAccessTokensDeleted = 0;
  agentDataMaintenanceMetrics.clientAccessExpiryFailed = 0;
  pendingOperations.clear();
};
