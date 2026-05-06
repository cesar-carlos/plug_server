/**
 * Counters and latency summaries for public token decisions on
 * `POST /api/v1/client-access/approve` and `.../reject`.
 */

export type ClientAgentAccessPublicDecision = "approve" | "reject";

export type ClientAgentAccessPublicDecisionOutcome =
  | "approved"
  | "rejected"
  | "invalid_token"
  | "request_missing"
  | "expired"
  | "already_processed"
  | "client_missing"
  | "client_ineligible"
  | "agent_missing"
  | "agent_ineligible"
  | "rejected_client_missing"
  | "service_unavailable";

type DecisionMetricState = {
  startedTotal: number;
  latencyCount: number;
  latencySumMs: number;
  latencyMaxMs: number;
  outcomes: Record<ClientAgentAccessPublicDecisionOutcome, number>;
};

type DecisionMetricsMap = Record<ClientAgentAccessPublicDecision, DecisionMetricState>;

const createDecisionState = (): DecisionMetricState => ({
  startedTotal: 0,
  latencyCount: 0,
  latencySumMs: 0,
  latencyMaxMs: 0,
  outcomes: {
    approved: 0,
    rejected: 0,
    invalid_token: 0,
    request_missing: 0,
    expired: 0,
    already_processed: 0,
    client_missing: 0,
    client_ineligible: 0,
    agent_missing: 0,
    agent_ineligible: 0,
    rejected_client_missing: 0,
    service_unavailable: 0,
  },
});

const createMetricsState = (): DecisionMetricsMap => ({
  approve: createDecisionState(),
  reject: createDecisionState(),
});

let metrics = createMetricsState();

export const recordClientAgentAccessPublicDecisionStarted = (
  decision: ClientAgentAccessPublicDecision,
): void => {
  metrics[decision].startedTotal += 1;
};

export const recordClientAgentAccessPublicDecisionFinished = (payload: {
  readonly decision: ClientAgentAccessPublicDecision;
  readonly outcome: ClientAgentAccessPublicDecisionOutcome;
  readonly durationMs: number;
}): void => {
  const state = metrics[payload.decision];
  state.latencyCount += 1;
  state.latencySumMs += payload.durationMs;
  state.latencyMaxMs = Math.max(state.latencyMaxMs, payload.durationMs);
  state.outcomes[payload.outcome] += 1;
};

export const getClientAgentAccessPublicDecisionMetricsSnapshot = (): {
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

export const resetClientAgentAccessPublicDecisionMetricsForTests = (): void => {
  metrics = createMetricsState();
};
