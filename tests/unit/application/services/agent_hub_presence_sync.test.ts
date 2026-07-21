import { afterEach, describe, expect, it, vi } from "vitest";

const touch = vi.fn(async () => undefined);
const upsert = vi.fn(async () => undefined);
const removeIfSocketMatches = vi.fn(async () => undefined);

vi.mock("../../../../src/infrastructure/redis/presence/agent_hub_presence_redis", () => ({
  getAgentHubPresencePort: () => ({
    isEnabled: true,
    upsert,
    touch,
    removeIfSocketMatches,
    removeIfHubInstanceMatches: vi.fn(async () => undefined),
    resolveRoute: vi.fn(async () => null),
  }),
}));

import { env } from "../../../../src/shared/config/env";
import {
  resetAgentHubPresenceTouchThrottleForTests,
  syncAgentHubPresenceOnDisconnect,
  syncAgentHubPresenceOnRegister,
  syncAgentHubPresenceOnTouch,
} from "../../../../src/application/services/agent_hub_presence_sync";

describe("agent_hub_presence_sync touch throttle", () => {
  afterEach(() => {
    resetAgentHubPresenceTouchThrottleForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("throttles Redis touch within TTL/3 while always allowing the first call", async () => {
    vi.stubEnv("HUB_INSTANCE_ID", "hub-1");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await syncAgentHubPresenceOnTouch("agent-a");
    await syncAgentHubPresenceOnTouch("agent-a");
    expect(touch).toHaveBeenCalledTimes(1);

    const minIntervalMs = Math.max(1, Math.floor(env.agentHubPresenceTtlMs / 3));
    vi.advanceTimersByTime(minIntervalMs - 1);
    await syncAgentHubPresenceOnTouch("agent-a");
    expect(touch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await syncAgentHubPresenceOnTouch("agent-a");
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it("resets throttle on register and clears on disconnect", async () => {
    vi.stubEnv("HUB_INSTANCE_ID", "hub-1");
    // Force hubInstanceId read from already-parsed env — register needs non-empty id.
    // The sync module reads env.hubInstanceId; stub process env won't reload parsed env.
    // Use Object.defineProperty on the imported env object for this process.
    const originalHubId = env.hubInstanceId;
    Object.defineProperty(env, "hubInstanceId", { value: "hub-1", configurable: true });

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      await syncAgentHubPresenceOnRegister({
        agentId: "agent-b",
        socketId: "sock-1",
        connectedAtMs: Date.now(),
      });
      expect(upsert).toHaveBeenCalledTimes(1);

      await syncAgentHubPresenceOnTouch("agent-b");
      expect(touch).toHaveBeenCalledTimes(0);

      const minIntervalMs = Math.max(1, Math.floor(env.agentHubPresenceTtlMs / 3));
      vi.advanceTimersByTime(minIntervalMs);
      await syncAgentHubPresenceOnTouch("agent-b");
      expect(touch).toHaveBeenCalledTimes(1);

      await syncAgentHubPresenceOnDisconnect({ agentId: "agent-b", socketId: "sock-1" });
      expect(removeIfSocketMatches).toHaveBeenCalledWith("agent-b", "sock-1");

      await syncAgentHubPresenceOnTouch("agent-b");
      expect(touch).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(env, "hubInstanceId", { value: originalHubId, configurable: true });
    }
  });
});
