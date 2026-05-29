import { env } from "../../../../shared/config/env";
import type {
  BridgeCommand,
  BridgeSingleCommand,
} from "../../../../shared/validators/agent_command";
import { createFixedWindowSocketRateLimiter } from "./fixed_window_socket_rate_limiter";

/**
 * Fixed-window rate limit for Socket `agents:command` on `/consumers`.
 * Uses the same window and per-user cap as `POST /agents/commands` (`REST_AGENTS_COMMANDS_RATE_LIMIT_*`).
 * Counter is **independent** from the Express rate-limiter store (separate buckets per channel).
 * When `REST_AGENTS_COMMANDS_RATE_LIMIT_MAX` is `0`, enforcement is off (always allows).
 */

const limiter = createFixedWindowSocketRateLimiter({
  redisScope: "agents_command",
  getWindowMs: () => env.restAgentsCommandsRateLimitWindowMs,
  getMax: () => env.restAgentsCommandsRateLimitMax,
});

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

/**
 * @param userSub JWT `sub` when present; anonymous sockets use per-connection key.
 */
export const allowAgentsCommandSocket = (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): boolean => limiter.allow(buildIdentityKey(userSub, socketId), cost);

export const allowAgentsCommandSocketAsync = async (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): Promise<boolean> => limiter.allowAsync(buildIdentityKey(userSub, socketId), cost);

export const refundAgentsCommandSocket = (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): void => limiter.refund(buildIdentityKey(userSub, socketId), cost);

export const refundAgentsCommandSocketAsync = async (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): Promise<void> => limiter.refundAsync(buildIdentityKey(userSub, socketId), cost);

export const sweepAgentsCommandSocketRateLimitState = (): void => limiter.sweep();

/** Drop anonymous bucket when the socket disconnects (JWT users keep shared key until sweep). */
export const clearAgentsCommandSocketRateLimitStateForSocketId = (socketId: string): void =>
  limiter.deleteKey(`agents_cmd:anon:${socketId}`);

export const resetAgentsCommandSocketRateLimitState = (): void => limiter.reset();

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
  trackedKeys: limiter.trackedKeyCount(),
  allowedTotal: limiter.allowedTotal(),
  rejectedTotal: limiter.rejectedTotal(),
});
