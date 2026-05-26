import { env } from "../../../../shared/config/env";
import {
  consumeSocketRateLimitRedis,
  refundSocketRateLimitRedis,
} from "../../../../infrastructure/redis/socket_rate_limit_redis";
import type { BridgeCommand, BridgeSingleCommand } from "../../../../shared/validators/agent_command";

/**
 * Fixed-window rate limit for Socket `agents:command` on `/consumers`.
 * Uses the same window and per-user cap as `POST /agents/commands` (`REST_AGENTS_COMMANDS_RATE_LIMIT_*`).
 * Counter is **independent** from the Express rate-limiter store (separate buckets per channel).
 * When `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` is `0`, enforcement is off (always allows).
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

const buildIdentityKey = (userSub: string | undefined, socketId: string): string => {
  const trimmed = userSub?.trim();
  return trimmed ? `agents_cmd:user:${trimmed}` : `agents_cmd:anon:${socketId}`;
};

const estimateSingleCommandCost = (command: BridgeSingleCommand): number => {
  if (command.method === "sql.executeBatch") {
    return Math.max(1, command.params.commands.length);
  }
  return 1;
};

export const estimateAgentsCommandRateLimitCost = (
  command: BridgeCommand,
  weightedCosts: boolean = env.socketAgentsCommandRateLimitWeightedCosts,
): number => {
  if (!weightedCosts) {
    return 1;
  }
  if (Array.isArray(command)) {
    return Math.max(
      1,
      command.reduce((total, item) => total + estimateSingleCommandCost(item), 0),
    );
  }
  return estimateSingleCommandCost(command);
};

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
export const allowAgentsCommandSocket = (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): boolean => {
  if (env.restAgentsCommandsRateLimitMax === 0) {
    return true;
  }

  const key = buildIdentityKey(userSub, socketId);
  const state = ensureState(key);
  const safeCost = Math.max(1, Math.floor(cost));
  if (state.count + safeCost > env.restAgentsCommandsRateLimitMax) {
    metrics.rejected += 1;
    return false;
  }
  state.count += safeCost;
  metrics.allowed += 1;
  return true;
};

export const allowAgentsCommandSocketAsync = async (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): Promise<boolean> => {
  if (env.restAgentsCommandsRateLimitMax === 0) {
    return true;
  }

  const key = buildIdentityKey(userSub, socketId);
  const safeCost = Math.max(1, Math.floor(cost));
  const redisDecision = await consumeSocketRateLimitRedis({
    scope: "agents_command",
    key,
    windowMs: env.restAgentsCommandsRateLimitWindowMs,
    max: env.restAgentsCommandsRateLimitMax,
    cost: safeCost,
  });
  if (redisDecision) {
    if (redisDecision.allowed) {
      metrics.allowed += 1;
      return true;
    }
    metrics.rejected += 1;
    return false;
  }

  return allowAgentsCommandSocket(userSub, socketId, safeCost);
};

export const refundAgentsCommandSocket = (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): void => {
  const key = buildIdentityKey(userSub, socketId);
  const state = statesByKey.get(key);
  if (!state || state.count <= 0) {
    return;
  }
  state.count = Math.max(0, state.count - Math.max(1, Math.floor(cost)));
};

export const refundAgentsCommandSocketAsync = async (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): Promise<void> => {
  const key = buildIdentityKey(userSub, socketId);
  const safeCost = Math.max(1, Math.floor(cost));
  await refundSocketRateLimitRedis({ scope: "agents_command", key, cost: safeCost });
  refundAgentsCommandSocket(userSub, socketId, safeCost);
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
  readonly weightedCosts: boolean;
  readonly trackedKeys: number;
  readonly allowedTotal: number;
  readonly rejectedTotal: number;
} => ({
  windowMs: env.restAgentsCommandsRateLimitWindowMs,
  maxPerWindow: env.restAgentsCommandsRateLimitMax,
  weightedCosts: env.socketAgentsCommandRateLimitWeightedCosts,
  trackedKeys: statesByKey.size,
  allowedTotal: metrics.allowed,
  rejectedTotal: metrics.rejected,
});
