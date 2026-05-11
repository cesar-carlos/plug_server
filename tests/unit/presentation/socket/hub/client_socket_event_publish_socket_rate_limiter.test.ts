import type * as EnvModule from "../../../../../src/shared/config/env";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketCustomEventPublishRateLimitMax: 3,
      socketCustomEventPublishRateLimitWindowMs: mod.env.socketCustomEventPublishRateLimitWindowMs,
      socketRelayRateLimitSweepStaleMultiplier: mod.env.socketRelayRateLimitSweepStaleMultiplier,
    },
  };
});

import { env } from "../../../../../src/shared/config/env";
import {
  allowClientSocketEventPublishSocket,
  getClientSocketEventPublishSocketRateLimitMetricsSnapshot,
  resetClientSocketEventPublishSocketRateLimitState,
  sweepClientSocketEventPublishSocketRateLimitState,
} from "../../../../../src/presentation/socket/hub/client_socket_event_publish_socket_rate_limiter";

describe("client_socket_event_publish_socket_rate_limiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetClientSocketEventPublishSocketRateLimitState();
  });

  it("should reject after max publishes per client sub in window", () => {
    const sub = "client-rl-1";
    const max = env.socketCustomEventPublishRateLimitMax;
    for (let i = 0; i < max; i += 1) {
      expect(allowClientSocketEventPublishSocket(sub)).toBe(true);
    }
    expect(allowClientSocketEventPublishSocket(sub)).toBe(false);
    const snap = getClientSocketEventPublishSocketRateLimitMetricsSnapshot();
    expect(snap.allowedTotal).toBe(max);
    expect(snap.rejectedTotal).toBe(1);
  });

  it("should use separate buckets for different client subs", () => {
    expect(allowClientSocketEventPublishSocket("c-a")).toBe(true);
    expect(allowClientSocketEventPublishSocket("c-b")).toBe(true);
  });

  it("sweep removes stale entries", () => {
    vi.useFakeTimers();
    allowClientSocketEventPublishSocket("c-sweep");
    const staleMs =
      env.restSocketEventRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;
    vi.advanceTimersByTime(staleMs + 1);
    sweepClientSocketEventPublishSocketRateLimitState();
    expect(getClientSocketEventPublishSocketRateLimitMetricsSnapshot().trackedKeys).toBe(0);
  });
});
