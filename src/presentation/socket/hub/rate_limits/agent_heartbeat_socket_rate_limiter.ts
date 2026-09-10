import { createFixedWindowSocketRateLimiter } from "./fixed_window_socket_rate_limiter";
import { env } from "../../../../shared/config/env";

/**
 * Per-connection heartbeat guard. Socket ids are process-local, so sharing
 * this state through Redis would add latency without improving enforcement.
 */
const heartbeatLimiter = createFixedWindowSocketRateLimiter({
  getWindowMs: () => env.socketAgentHeartbeatRateLimitWindowMs,
  getMax: () => env.socketAgentHeartbeatRateLimitMax,
});

export const allowAgentHeartbeatSocketEvent = (socketId: string): boolean =>
  heartbeatLimiter.allow(`agent_heartbeat:${socketId}`);

export const clearAgentHeartbeatSocketRateLimitStateForSocketId = (socketId: string): void => {
  heartbeatLimiter.deleteKey(`agent_heartbeat:${socketId}`);
};

export const sweepAgentHeartbeatSocketRateLimitState = (): void => {
  heartbeatLimiter.sweep();
};

export const resetAgentHeartbeatSocketRateLimitState = (): void => {
  heartbeatLimiter.reset();
};
