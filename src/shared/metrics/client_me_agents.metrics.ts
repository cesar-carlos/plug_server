/**
 * Counters for `GET /api/v1/client/me/agents` and `.../:agentId` (exposed via GET /metrics).
 */

let listResponsesTotal = 0;
let listHubConnectedTrueTotal = 0;
let detailResponsesTotal = 0;
let detailHubConnectedTrueTotal = 0;

export const recordClientMeAgentsListResponse = (hubConnectedTrueInPage: number): void => {
  listResponsesTotal += 1;
  listHubConnectedTrueTotal += hubConnectedTrueInPage;
};

export const recordClientMeAgentsDetailResponse = (isHubConnected: boolean): void => {
  detailResponsesTotal += 1;
  if (isHubConnected) {
    detailHubConnectedTrueTotal += 1;
  }
};

export const getClientMeAgentsMetricsSnapshot = (): {
  readonly listResponsesTotal: number;
  readonly listHubConnectedTrueTotal: number;
  readonly detailResponsesTotal: number;
  readonly detailHubConnectedTrueTotal: number;
} => ({
  listResponsesTotal,
  listHubConnectedTrueTotal,
  detailResponsesTotal,
  detailHubConnectedTrueTotal,
});

export const resetClientMeAgentsMetricsForTests = (): void => {
  listResponsesTotal = 0;
  listHubConnectedTrueTotal = 0;
  detailResponsesTotal = 0;
  detailHubConnectedTrueTotal = 0;
};
