import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import {
  startAgentIdleTimeoutScheduler,
  stopAgentIdleTimeoutScheduler,
  sweepIdleAgentConnections,
} from "../../../../../src/presentation/socket/hub/agent_idle_timeout_scheduler";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "../../../../../src/shared/metrics/socket_agent.metrics";

const disconnect = vi.fn();

vi.mock("../../../../../src/socket", () => ({
  agentsNamespace: {
    sockets: new Map<string, { connected: boolean; disconnect: typeof disconnect }>(),
  },
}));

vi.mock("../../../../../src/shared/config/env", () => ({
  env: {
    socketAgentIdleTimeoutMs: 60_000,
    socketAgentIdleSweepIntervalMs: 1_000,
  },
}));

import { agentsNamespace } from "../../../../../src/socket";

describe("agent_idle_timeout_scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSocketAgentMetrics();
    agentRegistry.clear();
    disconnect.mockReset();
    agentsNamespace!.sockets.clear();
    stopAgentIdleTimeoutScheduler();
  });

  afterEach(() => {
    stopAgentIdleTimeoutScheduler();
    vi.useRealTimers();
    agentRegistry.clear();
  });

  it("disconnects connected agents idle longer than the threshold", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    agentRegistry.registerAgentSession({
      agentId: "ag-idle",
      socketId: "sock-idle",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: () => true,
    });

    agentsNamespace!.sockets.set("sock-idle", { connected: true, disconnect });

    vi.setSystemTime(new Date("2026-05-08T10:02:00.000Z"));
    const disconnected = sweepIdleAgentConnections();

    expect(disconnected).toBe(1);
    expect(disconnect).toHaveBeenCalledWith(true);
    expect(getSocketAgentMetricsSnapshot().agentIdleTimeoutDisconnectTotal).toBe(1);
  });

  it("skips agents that are still within the idle threshold", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    agentRegistry.registerAgentSession({
      agentId: "ag-active",
      socketId: "sock-active",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: () => true,
    });
    agentsNamespace!.sockets.set("sock-active", { connected: true, disconnect });

    vi.setSystemTime(new Date("2026-05-08T10:00:30.000Z"));
    expect(sweepIdleAgentConnections()).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("runs periodic sweeps until stopped", () => {
    vi.setSystemTime(new Date("2026-05-08T10:00:00.000Z"));
    agentRegistry.registerAgentSession({
      agentId: "ag-timer",
      socketId: "sock-timer",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: () => true,
    });
    agentsNamespace!.sockets.set("sock-timer", { connected: true, disconnect });

    startAgentIdleTimeoutScheduler();
    vi.setSystemTime(new Date("2026-05-08T10:02:00.000Z"));
    vi.advanceTimersByTime(1_000);

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
