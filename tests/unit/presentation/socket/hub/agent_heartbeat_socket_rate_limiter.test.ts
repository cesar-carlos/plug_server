import { afterEach, describe, expect, it } from "vitest";

import {
  allowAgentHeartbeatSocketEvent,
  resetAgentHeartbeatSocketRateLimitState,
} from "../../../../../src/presentation/socket/hub/rate_limits/agent_heartbeat_socket_rate_limiter";
import { env } from "../../../../../src/shared/config/env";

describe("agent heartbeat socket rate limiter", () => {
  const originalMax = env.socketAgentHeartbeatRateLimitMax;
  const originalWindowMs = env.socketAgentHeartbeatRateLimitWindowMs;

  afterEach(() => {
    env.socketAgentHeartbeatRateLimitMax = originalMax;
    env.socketAgentHeartbeatRateLimitWindowMs = originalWindowMs;
    resetAgentHeartbeatSocketRateLimitState();
  });

  it("should reject an agent heartbeat burst independently for each socket", () => {
    env.socketAgentHeartbeatRateLimitMax = 1;
    env.socketAgentHeartbeatRateLimitWindowMs = 60_000;

    expect(allowAgentHeartbeatSocketEvent("socket-a")).toBe(true);
    expect(allowAgentHeartbeatSocketEvent("socket-a")).toBe(false);
    expect(allowAgentHeartbeatSocketEvent("socket-b")).toBe(true);
  });
});
