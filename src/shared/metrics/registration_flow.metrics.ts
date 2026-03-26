/**
 * Lightweight counters for registration approval flow (exposed via GET /metrics).
 */

let registrationApprovedTotal = 0;
let registrationRejectedTotal = 0;
let registrationTokenExpiredTotal = 0;

export const incrementRegistrationApproved = (): void => {
  registrationApprovedTotal += 1;
};

export const incrementRegistrationRejected = (): void => {
  registrationRejectedTotal += 1;
};

export const incrementRegistrationTokenExpired = (): void => {
  registrationTokenExpiredTotal += 1;
};

export const getRegistrationFlowMetricsSnapshot = (): {
  readonly registrationApprovedTotal: number;
  readonly registrationRejectedTotal: number;
  readonly registrationTokenExpiredTotal: number;
} => ({
  registrationApprovedTotal,
  registrationRejectedTotal,
  registrationTokenExpiredTotal,
});

export const resetRegistrationFlowMetrics = (): void => {
  registrationApprovedTotal = 0;
  registrationRejectedTotal = 0;
  registrationTokenExpiredTotal = 0;
};
