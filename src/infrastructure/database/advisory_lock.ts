/**
 * Postgres advisory-lock helper for multi-replica maintenance jobs.
 *
 * In production, every replica of `plug_server` runs the same retention/prune
 * schedulers (`socket_audit`, `bridge_latency_traces`, `agent_data_maintenance`,
 * `client_agent_access expiry`). Without coordination, all replicas execute the
 * same DELETE batches against the same rows, multiplying DB load and lock churn
 * for no extra throughput.
 *
 * `runWithAdvisoryLock` wraps a function with a Postgres session-level
 * `pg_try_advisory_lock(lockId)` call: only one replica acquires the lock at a
 * time; others skip the run and log at debug. The lock is always released in
 * `finally`, including on errors. If the lock cannot be acquired, the function
 * is NOT executed and the helper returns `{ acquired: false, result: null }`.
 *
 * Lock IDs are stable hashes — pick distinct constants per job in
 * `MAINTENANCE_LOCK_IDS` below. Postgres `bigint` lock id space is 64 bits;
 * we use small monotonically-assigned numbers (no collision risk).
 */

import { prismaClient } from "./prisma/client";
import { logger } from "../../shared/utils/logger";

/**
 * Stable lock ids for each maintenance job. Do not reuse or change values once
 * deployed — replicas running an older version would race against newer ids.
 */
export const MAINTENANCE_LOCK_IDS = {
  socketAuditPrune: 11_001n,
  bridgeLatencyTracePrune: 11_002n,
  agentProfileMaintenance: 11_003n,
  clientAgentAccessExpirySweep: 11_004n,
  registrationOutboxDeadLetterPrune: 11_005n,
  bridgeLatencyHourlyRollupRefresh: 11_006n,
  agentAutoUpdateDiagnosticsPrune: 11_007n,
} as const;

export interface AdvisoryLockOutcome<T> {
  /** `true` when the lock was acquired and `fn` ran. `false` when another replica held it. */
  readonly acquired: boolean;
  /** Return value of `fn`, or `null` when the lock was not acquired. */
  readonly result: T | null;
}

/**
 * Attempts to acquire `lockId` via `pg_try_advisory_lock`. If acquired, runs
 * `fn` and releases the lock in `finally`. Otherwise returns
 * `{ acquired: false, result: null }` immediately so the caller can skip
 * gracefully.
 */
export const runWithAdvisoryLock = async <T>(
  lockId: bigint,
  jobName: string,
  fn: () => Promise<T>,
): Promise<AdvisoryLockOutcome<T>> => {
  let acquired = false;
  try {
    const rows = await prismaClient.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(${lockId}) AS "acquired"
    `;
    acquired = rows[0]?.acquired === true;
  } catch (error: unknown) {
    logger.warn("advisory_lock_acquire_failed", {
      jobName,
      lockId: lockId.toString(),
      message: error instanceof Error ? error.message : String(error),
    });
    return { acquired: false, result: null };
  }

  if (!acquired) {
    logger.debug("advisory_lock_skipped", {
      jobName,
      lockId: lockId.toString(),
      reason: "held_by_other_replica",
    });
    return { acquired: false, result: null };
  }

  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    try {
      await prismaClient.$queryRaw`SELECT pg_advisory_unlock(${lockId})`;
    } catch (error: unknown) {
      logger.warn("advisory_lock_release_failed", {
        jobName,
        lockId: lockId.toString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
