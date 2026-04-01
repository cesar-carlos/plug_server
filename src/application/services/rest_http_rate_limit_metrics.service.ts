/**
 * Counters for Express HTTP rate limiters (REST API path). Exposed via GET /metrics.
 */

let globalRejectedTotal = 0;
let agentsCommandsUserRejectedTotal = 0;
let agentsCommandsIpRejectedTotal = 0;
let adminUserStatusRejectedTotal = 0;
let meAgentsPostRejectedTotal = 0;

export const incrementRestHttpGlobalRateLimitRejected = (): void => {
  globalRejectedTotal += 1;
};

export const incrementRestHttpAgentsCommandsUserRateLimitRejected = (): void => {
  agentsCommandsUserRejectedTotal += 1;
};

export const incrementRestHttpAgentsCommandsIpRateLimitRejected = (): void => {
  agentsCommandsIpRejectedTotal += 1;
};

export const incrementRestHttpAdminUserStatusRateLimitRejected = (): void => {
  adminUserStatusRejectedTotal += 1;
};

export const incrementRestHttpMeAgentsPostRateLimitRejected = (): void => {
  meAgentsPostRejectedTotal += 1;
};

export const getRestHttpRateLimitMetricsSnapshot = (): {
  readonly globalRejectedTotal: number;
  readonly agentsCommandsUserRejectedTotal: number;
  readonly agentsCommandsIpRejectedTotal: number;
  readonly adminUserStatusRejectedTotal: number;
  readonly meAgentsPostRejectedTotal: number;
} => ({
  globalRejectedTotal,
  agentsCommandsUserRejectedTotal,
  agentsCommandsIpRejectedTotal,
  adminUserStatusRejectedTotal,
  meAgentsPostRejectedTotal,
});

export const resetRestHttpRateLimitMetrics = (): void => {
  globalRejectedTotal = 0;
  agentsCommandsUserRejectedTotal = 0;
  agentsCommandsIpRejectedTotal = 0;
  adminUserStatusRejectedTotal = 0;
  meAgentsPostRejectedTotal = 0;
};
