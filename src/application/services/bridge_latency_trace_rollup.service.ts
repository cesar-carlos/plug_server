/**
 * Periodic refresh of the `bridge_latency_trace_hourly_rollups` materialized view.
 *
 * The view is created with `WITH NO DATA` initially and refreshed by this
 * scheduler using `REFRESH MATERIALIZED VIEW CONCURRENTLY`. CONCURRENTLY
 * keeps the previous snapshot readable during refresh (no AccessExclusiveLock
 * on the view), at the cost of requiring a UNIQUE index (defined in the
 * conversion migration `20260418170100_bridge_latency_hourly_rollups_matview`).
 *
 * Multi-replica coordination via `runWithAdvisoryLock` ensures only one
 * replica runs a refresh at a time, even if all replicas tick concurrently.
 */

import { prismaClient } from "../../infrastructure/database/prisma/client";
import {
  MAINTENANCE_LOCK_IDS,
  runWithAdvisoryLock,
} from "../../infrastructure/database/advisory_lock";
import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

let refreshTimer: NodeJS.Timeout | null = null;

const refreshMetrics = {
  refreshAttempts: 0,
  refreshSucceeded: 0,
  refreshFailed: 0,
  refreshSkippedAdvisoryLock: 0,
  lastRefreshDurationMs: 0,
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isConcurrentRefreshIndexError = (message: string): boolean =>
  message.includes("cannot refresh materialized view") && message.includes("concurrently");

/**
 * Refreshes the materialized view. Returns the elapsed time in ms, or `null`
 * when the refresh failed or the advisory lock was not acquired.
 */
export const refreshBridgeLatencyTraceRollups = async (): Promise<number | null> => {
  refreshMetrics.refreshAttempts += 1;

  const outcome = await runWithAdvisoryLock(
    MAINTENANCE_LOCK_IDS.bridgeLatencyHourlyRollupRefresh,
    "bridge_latency_hourly_rollup_refresh",
    async () => {
      const t0 = Date.now();
      try {
        await prismaClient.$executeRawUnsafe(
          "REFRESH MATERIALIZED VIEW CONCURRENTLY bridge_latency_trace_hourly_rollups",
        );
        const elapsed = Date.now() - t0;
        refreshMetrics.refreshSucceeded += 1;
        refreshMetrics.lastRefreshDurationMs = elapsed;
        logger.debug("bridge_latency_rollup_refreshed", { elapsedMs: elapsed });
        return elapsed;
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        if (isConcurrentRefreshIndexError(message)) {
          try {
            await prismaClient.$executeRawUnsafe(
              "REFRESH MATERIALIZED VIEW bridge_latency_trace_hourly_rollups",
            );
            const elapsed = Date.now() - t0;
            refreshMetrics.refreshSucceeded += 1;
            refreshMetrics.lastRefreshDurationMs = elapsed;
            logger.warn("bridge_latency_rollup_refreshed_non_concurrent", {
              elapsedMs: elapsed,
              message:
                "CONCURRENTLY refresh failed (missing unique index?); used blocking refresh. Apply prisma/migrations/20260418170100_bridge_latency_hourly_rollups_matview and 20260426120000_ensure_bridge_latency_hourly_rollups_unique_index, then use CONCURRENTLY again.",
            });
            return elapsed;
          } catch (fallbackError: unknown) {
            refreshMetrics.refreshFailed += 1;
            logger.warn("bridge_latency_rollup_refresh_failed", {
              message: toErrorMessage(fallbackError),
            });
            return null;
          }
        }
        refreshMetrics.refreshFailed += 1;
        logger.warn("bridge_latency_rollup_refresh_failed", { message });
        return null;
      }
    },
  );

  if (!outcome.acquired) {
    refreshMetrics.refreshSkippedAdvisoryLock += 1;
    return null;
  }

  return outcome.result;
};

export const startBridgeLatencyTraceRollupScheduler = (options?: {
  readonly intervalMs?: number;
}): void => {
  if (refreshTimer) {
    return;
  }

  const intervalMinutes = env.bridgeLatencyTraceRollupRefreshIntervalMinutes;
  if (intervalMinutes <= 0) {
    return;
  }

  const intervalMs = options?.intervalMs ?? intervalMinutes * 60 * 1000;
  const run = (): void => {
    void refreshBridgeLatencyTraceRollups();
  };

  run();
  refreshTimer = setInterval(run, intervalMs);
  refreshTimer.unref?.();
};

export const stopBridgeLatencyTraceRollupScheduler = (): void => {
  if (!refreshTimer) {
    return;
  }
  clearInterval(refreshTimer);
  refreshTimer = null;
};

export const getBridgeLatencyTraceRollupMetricsSnapshot = (): {
  readonly refreshAttempts: number;
  readonly refreshSucceeded: number;
  readonly refreshFailed: number;
  readonly refreshSkippedAdvisoryLock: number;
  readonly lastRefreshDurationMs: number;
} => ({
  refreshAttempts: refreshMetrics.refreshAttempts,
  refreshSucceeded: refreshMetrics.refreshSucceeded,
  refreshFailed: refreshMetrics.refreshFailed,
  refreshSkippedAdvisoryLock: refreshMetrics.refreshSkippedAdvisoryLock,
  lastRefreshDurationMs: refreshMetrics.lastRefreshDurationMs,
});
