import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAgentHealthPiggybackState } from "../../../../../../src/application/services/agent_health_piggyback.service";
import { agentRegistry } from "../../../../../../src/presentation/socket/hub/registries/agent_registry";
import {
  resetAgentHealthPollSchedulerForTests,
  runAgentHealthPollSweep,
} from "../../../../../../src/presentation/socket/hub/scheduling/agent_health_poll_scheduler";

const registerReadyAgent = (
  agentId: string,
  capabilities: Record<string, unknown>,
): void => {
  const result = agentRegistry.registerAgentSession({
    agentId,
    socketId: `socket-${agentId}`,
    userId: "user-1",
    capabilities,
    policy: "legacy_silent_takeover",
    isPeerConnected: () => true,
  });
  expect(result.ok).toBe(true);
  agentRegistry.touch(agentId, { markProtocolReady: true });
};

describe("agent_health_poll_scheduler", () => {
  afterEach(() => {
    agentRegistry.clear();
    clearAgentHealthPiggybackState();
    resetAgentHealthPollSchedulerForTests();
  });

  it("skips poll when piggyback snapshot is still fresh", async () => {
    const nowMs = 1_700_000_000_000;
    const dispatch = vi.fn().mockResolvedValue({ requestId: "r1", response: {} });

    registerReadyAgent("agent-1", {
      extensions: {
        healthPiggyback: { intervalRequests: 50, freshnessThresholdMs: 5000 },
      },
    });

    const { maybeRecordAgentHealthPiggyback } = await import(
      "../../../../../../src/application/services/agent_health_piggyback.service"
    );
    maybeRecordAgentHealthPiggyback({
      agentId: "agent-1",
      agentCapabilities: {
        extensions: { healthPiggyback: { freshnessThresholdMs: 5000 } },
      },
      rpcBody: {
        meta: {
          health_snapshot: {
            captured_at_ms: nowMs - 1000,
            status: "healthy",
          },
        },
      },
      nowMs,
    });

    const summary = await runAgentHealthPollSweep(dispatch, nowMs);
    expect(summary.skipped).toBe(1);
    expect(summary.polled).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("polls when piggyback snapshot is stale", async () => {
    const nowMs = 1_700_000_000_000;
    const dispatch = vi.fn().mockResolvedValue({
      requestId: "r1",
      response: { result: { status: "healthy" } },
    });

    registerReadyAgent("agent-2", {
      extensions: {
        healthPiggyback: { intervalRequests: 50, freshnessThresholdMs: 5000 },
      },
    });

    const summary = await runAgentHealthPollSweep(dispatch, nowMs);
    expect(summary.polled).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-2",
        command: expect.objectContaining({ method: "agent.getHealth" }),
      }),
    );
  });
});
