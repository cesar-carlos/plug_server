import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    restAgentsCommandsRateLimitMax: 0,
    restAgentsCommandsRateLimitWindowMs: 60_000,
    socketRelayRateLimitSweepStaleMultiplier: 3,
  },
}));

import { allowAgentsCommandSocket } from "../../../../../src/presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";

describe("agents_command_socket_rate_limiter (REST_AGENTS_COMMANDS_RATE_LIMIT_MAX=0)", () => {
  it("never rejects when per-window max is 0 (unlimited)", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(allowAgentsCommandSocket("sub-u", "sock-1")).toBe(true);
    }
  });
});
