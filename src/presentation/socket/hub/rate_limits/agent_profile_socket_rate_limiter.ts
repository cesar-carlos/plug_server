import { env } from "../../../../shared/config/env";

interface WindowState {
  windowStartMs: number;
  count: number;
  lastSeenAtMs: number;
}

const statesByKey = new Map<string, WindowState>();

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

export const allowAgentProfileSocketUpdate = (agentId: string, socketId: string): boolean => {
  // Align with HTTP `agentsSelfProfileRateLimit`: max === 0 disables limiting (passthrough).
  if (env.restAgentsCommandsRateLimitMax === 0) {
    return true;
  }

  const trimmedAgentId = agentId.trim();
  const key = trimmedAgentId
    ? `agent_profile_update:agent:${trimmedAgentId}`
    : `agent_profile_update:socket:${socketId}`;
  const state = ensureState(key);
  if (state.count >= env.restAgentsCommandsRateLimitMax) {
    return false;
  }
  state.count += 1;
  return true;
};

export const sweepAgentProfileSocketRateLimitState = (): void => {
  const nowMs = Date.now();
  const staleMs = staleAfterMs();
  for (const [mapKey, state] of statesByKey.entries()) {
    if (nowMs - state.lastSeenAtMs >= staleMs) {
      statesByKey.delete(mapKey);
    }
  }
};

export const clearAgentProfileSocketRateLimitStateForAgentId = (agentId: string): void => {
  statesByKey.delete(`agent_profile_update:agent:${agentId}`);
};

export const clearAgentProfileSocketRateLimitStateForSocketId = (socketId: string): void => {
  statesByKey.delete(`agent_profile_update:socket:${socketId}`);
};

export const resetAgentProfileSocketRateLimitState = (): void => {
  statesByKey.clear();
};
