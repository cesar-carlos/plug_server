import { afterEach, describe, expect, it } from "vitest";

import {
  allowAgentHeartbeatSocketEvent,
  resetAgentHeartbeatSocketRateLimitState,
} from "../../../../../src/presentation/socket/hub/rate_limits/agent_heartbeat_socket_rate_limiter";
import { env } from "../../../../../src/shared/config/env";
import { overrideEnv } from "../../../../helpers/override_env";

describe("agent heartbeat socket rate limiter", () => {
  const originalMax = env.socketAgentHeartbeatRateLimitMax;
  const originalWindowMs = env.socketAgentHeartbeatRateLimitWindowMs;

  afterEach(() => {
    overrideEnv("socketAgentHeartbeatRateLimitMax", originalMax);
    overrideEnv("socketAgentHeartbeatRateLimitWindowMs", originalWindowMs);
    resetAgentHeartbeatSocketRateLimitState();
  });

  it("should reject an agent heartbeat burst independently for each socket", () => {
    overrideEnv("socketAgentHeartbeatRateLimitMax", 1);
    overrideEnv("socketAgentHeartbeatRateLimitWindowMs", 60_000);

    expect(allowAgentHeartbeatSocketEvent("socket-a")).toBe(true);
    expect(allowAgentHeartbeatSocketEvent("socket-a")).toBe(false);
    expect(allowAgentHeartbeatSocketEvent("socket-b")).toBe(true);
  });
});
