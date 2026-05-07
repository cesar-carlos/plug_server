import type * as EnvModule from "../../../../../src/shared/config/env";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      restAgentsCommandsRateLimitMax: 100,
      restAgentsCommandsRateLimitWindowMs: mod.env.restAgentsCommandsRateLimitWindowMs,
      socketRelayRateLimitSweepStaleMultiplier: mod.env.socketRelayRateLimitSweepStaleMultiplier,
    },
  };
});

import { env } from "../../../../../src/shared/config/env";
import {
  allowAgentsCommandSocket,
  getAgentsCommandSocketRateLimitMetricsSnapshot,
  resetAgentsCommandSocketRateLimitState,
  sweepAgentsCommandSocketRateLimitState,
} from "../../../../../src/presentation/socket/hub/agents_command_socket_rate_limiter";

describe("agents_command_socket_rate_limiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetAgentsCommandSocketRateLimitState();
  });

  it("should reject after REST_AGENTS_COMMANDS_RATE_LIMIT_MAX allows per JWT sub per window", () => {
    const sub = "user-rate-test-1";
    const socketId = "sock-1";
    const max = env.restAgentsCommandsRateLimitMax;

    for (let i = 0; i < max; i += 1) {
      expect(allowAgentsCommandSocket(sub, socketId)).toBe(true);
    }
    expect(allowAgentsCommandSocket(sub, socketId)).toBe(false);

    const snap = getAgentsCommandSocketRateLimitMetricsSnapshot();
    expect(snap.allowedTotal).toBe(max);
    expect(snap.rejectedTotal).toBe(1);
  });

  it("should use separate buckets for different subs", () => {
    expect(allowAgentsCommandSocket("u-a", "s1")).toBe(true);
    expect(allowAgentsCommandSocket("u-b", "s2")).toBe(true);
  });

  it("should reset window after REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS", () => {
    vi.useFakeTimers();
    const sub = "user-window-1";
    const socketId = "sock-w";
    const max = env.restAgentsCommandsRateLimitMax;

    for (let i = 0; i < max; i += 1) {
      expect(allowAgentsCommandSocket(sub, socketId)).toBe(true);
    }
    expect(allowAgentsCommandSocket(sub, socketId)).toBe(false);

    vi.advanceTimersByTime(env.restAgentsCommandsRateLimitWindowMs + 5);
    expect(allowAgentsCommandSocket(sub, socketId)).toBe(true);
  });

  it("sweep removes stale entries", () => {
    vi.useFakeTimers();
    allowAgentsCommandSocket(undefined, "orphan-socket");
    const staleMs =
      env.restAgentsCommandsRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;
    vi.advanceTimersByTime(staleMs + 1);
    sweepAgentsCommandSocketRateLimitState();
    expect(getAgentsCommandSocketRateLimitMetricsSnapshot().trackedKeys).toBe(0);
  });
});
