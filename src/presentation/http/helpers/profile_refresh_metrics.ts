import type { ProfileRefreshMetrics } from "../../../application/services/agent_profile_refresh_coordinator";

export const buildProfileRefreshMetricsLines = (
  snapshot: ProfileRefreshMetrics & { readonly cacheEntries: number },
): string[] => {
  const values: ReadonlyArray<readonly [string, string, number]> = [
    ["active", "gauge", snapshot.active],
    ["waiting", "gauge", snapshot.waiting],
    ["wait_seconds_count", "counter", snapshot.waitCount],
    ["wait_seconds_sum", "counter", snapshot.waitSumMs / 1000],
    ["wait_seconds_max", "gauge", snapshot.waitMaxMs / 1000],
    ["cancellations_total", "counter", snapshot.cancellations],
    ["cache_entries", "gauge", snapshot.cacheEntries],
  ];
  return values.flatMap(([suffix, type, value]) => [
    `# TYPE rest_agent_profile_refresh_${suffix} ${type}`,
    `rest_agent_profile_refresh_${suffix} ${value}`,
  ]);
};
