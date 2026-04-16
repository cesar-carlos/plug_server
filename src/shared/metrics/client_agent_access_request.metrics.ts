/**
 * Counters for `POST /api/v1/client/me/agents` outcomes (exposed via GET /metrics).
 */

let postRequestedTotal = 0;
let postNewRequestsTotal = 0;
let postReopenedTotal = 0;
let postDebouncedTotal = 0;
let postAlreadyApprovedTotal = 0;

export const recordClientAgentAccessRequestPost = (payload: {
  readonly requestedCount: number;
  readonly newCount: number;
  readonly reopenedCount: number;
  readonly debouncedCount: number;
  readonly alreadyApprovedCount: number;
}): void => {
  postRequestedTotal += payload.requestedCount;
  postNewRequestsTotal += payload.newCount;
  postReopenedTotal += payload.reopenedCount;
  postDebouncedTotal += payload.debouncedCount;
  postAlreadyApprovedTotal += payload.alreadyApprovedCount;
};

export const getClientAgentAccessRequestPostMetricsSnapshot = (): {
  readonly postRequestedTotal: number;
  readonly postNewRequestsTotal: number;
  readonly postReopenedTotal: number;
  readonly postDebouncedTotal: number;
  readonly postAlreadyApprovedTotal: number;
} => ({
  postRequestedTotal,
  postNewRequestsTotal,
  postReopenedTotal,
  postDebouncedTotal,
  postAlreadyApprovedTotal,
});

export const resetClientAgentAccessRequestPostMetricsForTests = (): void => {
  postRequestedTotal = 0;
  postNewRequestsTotal = 0;
  postReopenedTotal = 0;
  postDebouncedTotal = 0;
  postAlreadyApprovedTotal = 0;
};
