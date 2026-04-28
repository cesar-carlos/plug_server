/**
 * Counters for Express HTTP rate limiters (REST API path). Exposed via GET /metrics.
 */

let globalRejectedTotal = 0;
let credentialAuthRejectedTotal = 0;
let agentsCommandsUserRejectedTotal = 0;
let agentsCommandsIpRejectedTotal = 0;
let adminUserStatusRejectedTotal = 0;
let clientMeAgentsPostRejectedTotal = 0;

export const incrementRestHttpGlobalRateLimitRejected = (): void => {
  globalRejectedTotal += 1;
};

export const incrementRestHttpCredentialAuthRateLimitRejected = (): void => {
  credentialAuthRejectedTotal += 1;
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

export const incrementRestHttpClientMeAgentsPostRateLimitRejected = (): void => {
  clientMeAgentsPostRejectedTotal += 1;
};

export const getRestHttpRateLimitMetricsSnapshot = (): {
  readonly globalRejectedTotal: number;
  readonly credentialAuthRejectedTotal: number;
  readonly agentsCommandsUserRejectedTotal: number;
  readonly agentsCommandsIpRejectedTotal: number;
  readonly adminUserStatusRejectedTotal: number;
  readonly clientMeAgentsPostRejectedTotal: number;
} => ({
  globalRejectedTotal,
  credentialAuthRejectedTotal,
  agentsCommandsUserRejectedTotal,
  agentsCommandsIpRejectedTotal,
  adminUserStatusRejectedTotal,
  clientMeAgentsPostRejectedTotal,
});

export const resetRestHttpRateLimitMetrics = (): void => {
  globalRejectedTotal = 0;
  credentialAuthRejectedTotal = 0;
  agentsCommandsUserRejectedTotal = 0;
  agentsCommandsIpRejectedTotal = 0;
  adminUserStatusRejectedTotal = 0;
  clientMeAgentsPostRejectedTotal = 0;
};
