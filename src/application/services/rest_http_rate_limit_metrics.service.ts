/**
 * Counters for Express HTTP rate limiters (REST API path). Exposed via GET /metrics.
 */

let globalRejectedTotal = 0;
let credentialAuthRejectedTotal = 0;
let tokenRefreshRejectedTotal = 0;
let agentsCommandsUserRejectedTotal = 0;
let agentsCommandsIpRejectedTotal = 0;
let agentsSelfProfileRejectedTotal = 0;
let adminUserStatusRejectedTotal = 0;
let clientMeAgentsPostRejectedTotal = 0;
let clientThumbnailRejectedTotal = 0;
let clientPasswordRecoveryRequestRejectedTotal = 0;
let clientSocketEventPublishRejectedTotal = 0;

export const incrementRestHttpGlobalRateLimitRejected = (): void => {
  globalRejectedTotal += 1;
};

export const incrementRestHttpCredentialAuthRateLimitRejected = (): void => {
  credentialAuthRejectedTotal += 1;
};

export const incrementRestHttpTokenRefreshRateLimitRejected = (): void => {
  tokenRefreshRejectedTotal += 1;
};

export const incrementRestHttpAgentsCommandsUserRateLimitRejected = (): void => {
  agentsCommandsUserRejectedTotal += 1;
};

export const incrementRestHttpAgentsCommandsIpRateLimitRejected = (): void => {
  agentsCommandsIpRejectedTotal += 1;
};

export const incrementRestHttpAgentsSelfProfileRateLimitRejected = (): void => {
  agentsSelfProfileRejectedTotal += 1;
};

export const incrementRestHttpAdminUserStatusRateLimitRejected = (): void => {
  adminUserStatusRejectedTotal += 1;
};

export const incrementRestHttpClientMeAgentsPostRateLimitRejected = (): void => {
  clientMeAgentsPostRejectedTotal += 1;
};

export const incrementRestHttpClientThumbnailRateLimitRejected = (): void => {
  clientThumbnailRejectedTotal += 1;
};

export const incrementRestHttpClientPasswordRecoveryRequestRateLimitRejected = (): void => {
  clientPasswordRecoveryRequestRejectedTotal += 1;
};

export const incrementRestHttpClientSocketEventPublishRateLimitRejected = (): void => {
  clientSocketEventPublishRejectedTotal += 1;
};

export const getRestHttpRateLimitMetricsSnapshot = (): {
  readonly globalRejectedTotal: number;
  readonly credentialAuthRejectedTotal: number;
  readonly tokenRefreshRejectedTotal: number;
  readonly agentsCommandsUserRejectedTotal: number;
  readonly agentsCommandsIpRejectedTotal: number;
  readonly agentsSelfProfileRejectedTotal: number;
  readonly adminUserStatusRejectedTotal: number;
  readonly clientMeAgentsPostRejectedTotal: number;
  readonly clientThumbnailRejectedTotal: number;
  readonly clientPasswordRecoveryRequestRejectedTotal: number;
  readonly clientSocketEventPublishRejectedTotal: number;
} => ({
  globalRejectedTotal,
  credentialAuthRejectedTotal,
  tokenRefreshRejectedTotal,
  agentsCommandsUserRejectedTotal,
  agentsCommandsIpRejectedTotal,
  agentsSelfProfileRejectedTotal,
  adminUserStatusRejectedTotal,
  clientMeAgentsPostRejectedTotal,
  clientThumbnailRejectedTotal,
  clientPasswordRecoveryRequestRejectedTotal,
  clientSocketEventPublishRejectedTotal,
});

export const resetRestHttpRateLimitMetrics = (): void => {
  globalRejectedTotal = 0;
  credentialAuthRejectedTotal = 0;
  tokenRefreshRejectedTotal = 0;
  agentsCommandsUserRejectedTotal = 0;
  agentsCommandsIpRejectedTotal = 0;
  agentsSelfProfileRejectedTotal = 0;
  adminUserStatusRejectedTotal = 0;
  clientMeAgentsPostRejectedTotal = 0;
  clientThumbnailRejectedTotal = 0;
  clientPasswordRecoveryRequestRejectedTotal = 0;
  clientSocketEventPublishRejectedTotal = 0;
};
