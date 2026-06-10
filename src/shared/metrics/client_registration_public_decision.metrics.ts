/**
 * Counters and latency summaries for public token decisions on
 * `POST /api/v1/client-auth/registration/approve` and `.../reject`.
 */

export type ClientRegistrationPublicDecision = "approve" | "reject";

export type ClientRegistrationPublicDecisionOutcome =
  | "approved"
  | "rejected"
  | "invalid_token"
  | "expired"
  | "already_processed"
  | "client_missing"
  | "owner_ineligible";

type DecisionMetricState = {
  startedTotal: number;
  latencyCount: number;
  latencySumMs: number;
  latencyMaxMs: number;
  outcomes: Record<ClientRegistrationPublicDecisionOutcome, number>;
};

type DecisionMetricsMap = Record<ClientRegistrationPublicDecision, DecisionMetricState>;

const createDecisionState = (): DecisionMetricState => ({
  startedTotal: 0,
  latencyCount: 0,
  latencySumMs: 0,
  latencyMaxMs: 0,
  outcomes: {
    approved: 0,
    rejected: 0,
    invalid_token: 0,
    expired: 0,
    already_processed: 0,
    client_missing: 0,
    owner_ineligible: 0,
  },
});

const createMetricsState = (): DecisionMetricsMap => ({
  approve: createDecisionState(),
  reject: createDecisionState(),
});

let metrics = createMetricsState();

export const recordClientRegistrationPublicDecisionStarted = (
  decision: ClientRegistrationPublicDecision,
): void => {
  metrics[decision].startedTotal += 1;
};

export const recordClientRegistrationPublicDecisionFinished = (payload: {
  readonly decision: ClientRegistrationPublicDecision;
  readonly outcome: ClientRegistrationPublicDecisionOutcome;
  readonly durationMs: number;
}): void => {
  const state = metrics[payload.decision];
  state.latencyCount += 1;
  state.latencySumMs += payload.durationMs;
  state.latencyMaxMs = Math.max(state.latencyMaxMs, payload.durationMs);
  state.outcomes[payload.outcome] += 1;
};

export const getClientRegistrationPublicDecisionMetricsSnapshot = (): {
  readonly approve: DecisionMetricState & { readonly latencyAvgMs: number };
  readonly reject: DecisionMetricState & { readonly latencyAvgMs: number };
} => ({
  approve: {
    ...metrics.approve,
    latencyAvgMs:
      metrics.approve.latencyCount === 0
        ? 0
        : metrics.approve.latencySumMs / metrics.approve.latencyCount,
  },
  reject: {
    ...metrics.reject,
    latencyAvgMs:
      metrics.reject.latencyCount === 0
        ? 0
        : metrics.reject.latencySumMs / metrics.reject.latencyCount,
  },
});

export const resetClientRegistrationPublicDecisionMetricsForTests = (): void => {
  metrics = createMetricsState();
};
