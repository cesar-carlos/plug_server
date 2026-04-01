/**
 * Counters for `POST /me/agents` (self-service bind) outcomes — exposed via GET /metrics.
 */

export type UserAgentsSelfBindPostOutcome =
  | "success"
  | "inactive"
  | "not_found"
  | "not_online_offline"
  | "not_online_other"
  | "already_linked";

const initial: Record<UserAgentsSelfBindPostOutcome, number> = {
  success: 0,
  inactive: 0,
  not_found: 0,
  not_online_offline: 0,
  not_online_other: 0,
  already_linked: 0,
};

const counts: Record<UserAgentsSelfBindPostOutcome, number> = { ...initial };

export const incrementUserAgentsSelfBindPost = (outcome: UserAgentsSelfBindPostOutcome): void => {
  counts[outcome] += 1;
};

export const getUserAgentsSelfBindMetricsSnapshot = (): Readonly<
  Record<UserAgentsSelfBindPostOutcome, number>
> => ({ ...counts });

export const resetUserAgentsSelfBindMetrics = (): void => {
  for (const key of Object.keys(initial) as UserAgentsSelfBindPostOutcome[]) {
    counts[key] = 0;
  }
};
