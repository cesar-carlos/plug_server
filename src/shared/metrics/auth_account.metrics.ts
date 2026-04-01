/**
 * Counters for auth denial reasons (exposed via GET /metrics).
 */

let loginBlockedTotal = 0;
let refreshBlockedTotal = 0;
let socketBlockedTotal = 0;
let adminUserStatusSetTotal = 0;

export const incrementAuthLoginBlocked = (): void => {
  loginBlockedTotal += 1;
};

export const incrementAuthRefreshBlocked = (): void => {
  refreshBlockedTotal += 1;
};

export const incrementAuthSocketBlocked = (): void => {
  socketBlockedTotal += 1;
};

export const incrementAdminUserStatusSet = (): void => {
  adminUserStatusSetTotal += 1;
};

export const getAuthAccountMetricsSnapshot = (): {
  readonly loginBlockedTotal: number;
  readonly refreshBlockedTotal: number;
  readonly socketBlockedTotal: number;
  readonly adminUserStatusSetTotal: number;
} => ({
  loginBlockedTotal,
  refreshBlockedTotal,
  socketBlockedTotal,
  adminUserStatusSetTotal,
});

export const resetAuthAccountMetrics = (): void => {
  loginBlockedTotal = 0;
  refreshBlockedTotal = 0;
  socketBlockedTotal = 0;
  adminUserStatusSetTotal = 0;
};
