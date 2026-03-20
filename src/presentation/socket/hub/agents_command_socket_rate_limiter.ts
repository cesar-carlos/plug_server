import { env } from "../../../shared/config/env";

/**
 * Fixed-window rate limit for Socket `agents:command` on `/consumers`.
 * Uses the same window and per-user cap as `POST /agents/commands` (`REST_AGENTS_COMMANDS_RATE_LIMIT_*`).
 * Counter is **independent** from the Express rate-limiter store (separate buckets per channel).
 */

interface WindowState {
  windowStartMs: number;
  count: number;
  lastSeenAtMs: number;
}

const statesByKey = new Map<string, WindowState>();

const metrics = {
  allowed: 0,
  rejected: 0,
};

const staleAfterMs = (): number =>
  env.restAgentsCommandsRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;

const ensureState = (key: string): WindowState => {
  const nowMs = Date.now();
  const existing = statesByKey.get(key);
  if (!existing) {
    const created: WindowState = {
      windowStartMs: nowMs,
      count: 0,
      lastSeenAtMs: nowMs,
    };
    statesByKey.set(key, created);
    return created;
  }

  if (nowMs - existing.windowStartMs >= env.restAgentsCommandsRateLimitWindowMs) {
    existing.windowStartMs = nowMs;
    existing.count = 0;
  }
  existing.lastSeenAtMs = nowMs;
  return existing;
};

/**
 * @param userSub JWT `sub` when present; anonymous sockets use per-connection key.
 */
export const allowAgentsCommandSocket = (userSub: string | undefined, socketId: string): boolean => {
  const trimmed = userSub?.trim();
  const key = trimmed ? `agents_cmd:user:${trimmed}` : `agents_cmd:anon:${socketId}`;
  const state = ensureState(key);
  if (state.count >= env.restAgentsCommandsRateLimitMax) {
    metrics.rejected += 1;
    return false;
  }
  state.count += 1;
  metrics.allowed += 1;
  return true;
};

export const sweepAgentsCommandSocketRateLimitState = (): void => {
  const nowMs = Date.now();
  const staleMs = staleAfterMs();
  for (const [mapKey, state] of statesByKey.entries()) {
    if (nowMs - state.lastSeenAtMs >= staleMs) {
      statesByKey.delete(mapKey);
    }
  }
};

/** Drop anonymous bucket when the socket disconnects (JWT users keep shared key until sweep). */
export const clearAgentsCommandSocketRateLimitStateForSocketId = (socketId: string): void => {
  statesByKey.delete(`agents_cmd:anon:${socketId}`);
};

export const resetAgentsCommandSocketRateLimitState = (): void => {
  statesByKey.clear();
  metrics.allowed = 0;
  metrics.rejected = 0;
};

export const getAgentsCommandSocketRateLimitMetricsSnapshot = (): {
  readonly windowMs: number;
  readonly maxPerWindow: number;
  readonly trackedKeys: number;
  readonly allowedTotal: number;
  readonly rejectedTotal: number;
} => ({
  windowMs: env.restAgentsCommandsRateLimitWindowMs,
  maxPerWindow: env.restAgentsCommandsRateLimitMax,
  trackedKeys: statesByKey.size,
  allowedTotal: metrics.allowed,
  rejectedTotal: metrics.rejected,
});
