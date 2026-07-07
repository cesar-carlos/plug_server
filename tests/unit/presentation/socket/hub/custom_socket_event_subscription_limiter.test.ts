import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  allowCustomSocketEventSubscriptionControl,
  resetCustomSocketEventSubscriptionRateLimitState,
  sweepCustomSocketEventSubscriptionRateLimitState,
} from "../../../../../src/presentation/socket/hub/rate_limits/custom_socket_event_subscription_limiter";

const mutableEnv = env as unknown as {
  socketCustomEventSubscriptionRateLimitWindowMs: number;
  socketCustomEventSubscriptionRateLimitMax: number;
};

const originalWindowMs = env.socketCustomEventSubscriptionRateLimitWindowMs;
const originalMax = env.socketCustomEventSubscriptionRateLimitMax;

describe("custom socket event subscription limiter", () => {
  afterEach(() => {
    mutableEnv.socketCustomEventSubscriptionRateLimitWindowMs = originalWindowMs;
    mutableEnv.socketCustomEventSubscriptionRateLimitMax = originalMax;
    resetCustomSocketEventSubscriptionRateLimitState();
  });

  it("limits subscription control events per socket and resets by window", () => {
    mutableEnv.socketCustomEventSubscriptionRateLimitWindowMs = 1_000;
    mutableEnv.socketCustomEventSubscriptionRateLimitMax = 2;

    expect(allowCustomSocketEventSubscriptionControl("socket-1", 10_000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(allowCustomSocketEventSubscriptionControl("socket-1", 10_100)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(allowCustomSocketEventSubscriptionControl("socket-1", 10_200)).toMatchObject({
      allowed: false,
      retryAfterMs: 800,
    });
    expect(allowCustomSocketEventSubscriptionControl("socket-1", 11_000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("can be disabled with max zero", () => {
    mutableEnv.socketCustomEventSubscriptionRateLimitWindowMs = 1_000;
    mutableEnv.socketCustomEventSubscriptionRateLimitMax = 0;

    expect(allowCustomSocketEventSubscriptionControl("socket-1", 10_000)).toMatchObject({
      allowed: true,
      limit: 0,
    });
  });

  it("sweep removes stale buckets", () => {
    mutableEnv.socketCustomEventSubscriptionRateLimitWindowMs = 1_000;
    mutableEnv.socketCustomEventSubscriptionRateLimitMax = 5;
    allowCustomSocketEventSubscriptionControl("socket-stale", 10_000);

    const later =
      10_000 +
      env.socketCustomEventSubscriptionRateLimitWindowMs *
        env.socketRelayRateLimitSweepStaleMultiplier +
      1;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      sweepCustomSocketEventSubscriptionRateLimitState();
      expect(allowCustomSocketEventSubscriptionControl("socket-stale", later)).toMatchObject({
        allowed: true,
        remaining: 4,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
