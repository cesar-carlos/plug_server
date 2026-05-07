/**
 * Counters for `/agents` Socket.IO namespace authentication failures (handshake middleware).
 * Exposed via GET /metrics through `getSocketMetricsSnapshot`.
 */

export type AgentSocketAuthRejectReason =
  | "missing_token"
  | "invalid_token"
  | "role_denied"
  | "blocked_account"
  | "account_validation_error";

const authRejects: Record<AgentSocketAuthRejectReason, number> = {
  missing_token: 0,
  invalid_token: 0,
  role_denied: 0,
  blocked_account: 0,
  account_validation_error: 0,
};

let sessionRejectedActiveTotal = 0;
let sessionTakeoverDisconnectTotal = 0;
let sessionRegisterRateLimitedTotal = 0;

export const noteAgentSocketAuthRejected = (reason: AgentSocketAuthRejectReason): void => {
  authRejects[reason] += 1;
};

export const noteAgentSessionRejectedActive = (): void => {
  sessionRejectedActiveTotal += 1;
};

export const noteAgentSessionTakeoverDisconnect = (): void => {
  sessionTakeoverDisconnectTotal += 1;
};

export const noteAgentRegisterRateLimited = (): void => {
  sessionRegisterRateLimitedTotal += 1;
};

export const getSocketAgentMetricsSnapshot = (): {
  readonly authRejects: typeof authRejects;
  readonly sessionRejectedActiveTotal: number;
  readonly sessionTakeoverDisconnectTotal: number;
  readonly sessionRegisterRateLimitedTotal: number;
} => ({
  authRejects: { ...authRejects },
  sessionRejectedActiveTotal,
  sessionTakeoverDisconnectTotal,
  sessionRegisterRateLimitedTotal,
});

export const resetSocketAgentMetrics = (): void => {
  authRejects.missing_token = 0;
  authRejects.invalid_token = 0;
  authRejects.role_denied = 0;
  authRejects.blocked_account = 0;
  authRejects.account_validation_error = 0;
  sessionRejectedActiveTotal = 0;
  sessionTakeoverDisconnectTotal = 0;
  sessionRegisterRateLimitedTotal = 0;
};
