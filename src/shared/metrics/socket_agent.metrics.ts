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

export const noteAgentSocketAuthRejected = (reason: AgentSocketAuthRejectReason): void => {
  authRejects[reason] += 1;
};

export const getSocketAgentMetricsSnapshot = (): {
  readonly authRejects: typeof authRejects;
} => ({
  authRejects: { ...authRejects },
});

export const resetSocketAgentMetrics = (): void => {
  authRejects.missing_token = 0;
  authRejects.invalid_token = 0;
  authRejects.role_denied = 0;
  authRejects.blocked_account = 0;
  authRejects.account_validation_error = 0;
};
