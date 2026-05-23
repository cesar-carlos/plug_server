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
  allowAgentProfileSocketUpdate,
  clearAgentProfileSocketRateLimitStateForAgentId,
  clearAgentProfileSocketRateLimitStateForSocketId,
  resetAgentProfileSocketRateLimitState,
  sweepAgentProfileSocketRateLimitState,
} from "../../../../../src/presentation/socket/hub/agent_profile_socket_rate_limiter";

describe("agent_profile_socket_rate_limiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetAgentProfileSocketRateLimitState();
  });

  it("should reject after REST_AGENTS_COMMANDS_RATE_LIMIT_MAX allows per agent id per window", () => {
    const agentId = "agent-rate-test-1";
    const socketId = "sock-1";
    const max = env.restAgentsCommandsRateLimitMax;

    for (let i = 0; i < max; i += 1) {
      expect(allowAgentProfileSocketUpdate(agentId, socketId)).toBe(true);
    }
    expect(allowAgentProfileSocketUpdate(agentId, socketId)).toBe(false);
  });

  it("should use separate buckets for different agent ids", () => {
    expect(allowAgentProfileSocketUpdate("agent-a", "s1")).toBe(true);
    expect(allowAgentProfileSocketUpdate("agent-b", "s2")).toBe(true);
  });

  it("should bucket by socket id when agent id is blank", () => {
    const socketId = "orphan-socket";
    const max = env.restAgentsCommandsRateLimitMax;

    for (let i = 0; i < max; i += 1) {
      expect(allowAgentProfileSocketUpdate("   ", socketId)).toBe(true);
    }
    expect(allowAgentProfileSocketUpdate("", socketId)).toBe(false);
  });

  it("should reset window after REST_AGENTS_COMMANDS_RATE_LIMIT_WINDOW_MS", () => {
    vi.useFakeTimers();
    const agentId = "agent-window-1";
    const socketId = "sock-w";
    const max = env.restAgentsCommandsRateLimitMax;

    for (let i = 0; i < max; i += 1) {
      expect(allowAgentProfileSocketUpdate(agentId, socketId)).toBe(true);
    }
    expect(allowAgentProfileSocketUpdate(agentId, socketId)).toBe(false);

    vi.advanceTimersByTime(env.restAgentsCommandsRateLimitWindowMs + 5);
    expect(allowAgentProfileSocketUpdate(agentId, socketId)).toBe(true);
  });

  it("sweep removes stale entries", () => {
    vi.useFakeTimers();
    allowAgentProfileSocketUpdate("   ", "orphan-socket");
    const staleMs =
      env.restAgentsCommandsRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;
    vi.advanceTimersByTime(staleMs + 1);
    sweepAgentProfileSocketRateLimitState();

    const max = env.restAgentsCommandsRateLimitMax;
    for (let i = 0; i < max; i += 1) {
      expect(allowAgentProfileSocketUpdate("   ", "orphan-socket")).toBe(true);
    }
  });

  it("clear helpers remove only the targeted bucket", () => {
    const max = env.restAgentsCommandsRateLimitMax;
    for (let i = 0; i < max; i += 1) {
      allowAgentProfileSocketUpdate("agent-clear", "sock-clear");
    }
    expect(allowAgentProfileSocketUpdate("agent-clear", "sock-clear")).toBe(false);

    clearAgentProfileSocketRateLimitStateForAgentId("agent-clear");
    expect(allowAgentProfileSocketUpdate("agent-clear", "sock-clear")).toBe(true);

    for (let i = 0; i < max; i += 1) {
      allowAgentProfileSocketUpdate("   ", "sock-only");
    }
    expect(allowAgentProfileSocketUpdate("   ", "sock-only")).toBe(false);

    clearAgentProfileSocketRateLimitStateForSocketId("sock-only");
    expect(allowAgentProfileSocketUpdate("   ", "sock-only")).toBe(true);
  });

  it("should passthrough when REST_AGENTS_COMMANDS_RATE_LIMIT_MAX is zero", () => {
    const originalMax = env.restAgentsCommandsRateLimitMax;
    (env as { restAgentsCommandsRateLimitMax: number }).restAgentsCommandsRateLimitMax = 0;
    try {
      for (let i = 0; i < 200; i += 1) {
        expect(allowAgentProfileSocketUpdate("agent-unlimited", "sock-unlimited")).toBe(true);
      }
    } finally {
      (env as { restAgentsCommandsRateLimitMax: number }).restAgentsCommandsRateLimitMax =
        originalMax;
    }
  });
});
