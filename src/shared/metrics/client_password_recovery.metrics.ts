/**
 * Counters for client password recovery flow (exposed via GET /metrics).
 */

let emailCleanupFailedTotal = 0;

export const incrementClientPasswordRecoveryEmailCleanupFailed = (): void => {
  emailCleanupFailedTotal += 1;
};

export const getClientPasswordRecoveryMetricsSnapshot = (): {
  readonly emailCleanupFailedTotal: number;
} => ({
  emailCleanupFailedTotal,
});

export const resetClientPasswordRecoveryMetrics = (): void => {
  emailCleanupFailedTotal = 0;
};
