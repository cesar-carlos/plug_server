import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketRelayRateLimitWindowMs: 10_000,
    socketRelayRateLimitMaxConversationStarts: 0,
    socketRelayRateLimitMaxRequests: 0,
    socketRelayRateLimitMaxStreamPullCredits: 0,
    socketRelayRateLimitSweepStaleMultiplier: 3,
  },
}));

import {
  allowRelayConversationStart,
  allowRelayRpcRequest,
  allowRelayStreamPull,
  resetRelayRateLimiterState,
} from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";

describe("consumer_relay_rate_limiter (limits disabled via env = 0)", () => {
  beforeEach(() => {
    resetRelayRateLimiterState();
  });

  it("allowRelayConversationStart always allows without consuming budget", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(allowRelayConversationStart("user-disabled", "sock-a")).toBe(true);
    }
  });

  it("allowRelayRpcRequest always allows without consuming budget", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(allowRelayRpcRequest("user-disabled", "sock-b")).toBe(true);
    }
  });

  it("allowRelayStreamPull grants without credit cap", () => {
    const a = allowRelayStreamPull("user-disabled", "sock-c", 500_000);
    expect(a.allowed).toBe(true);
    expect(a.limit).toBe(0);
    expect(a.grantedCredits).toBe(500_000);
    expect(a.remainingCredits).toBe(Number.MAX_SAFE_INTEGER);
  });
});
