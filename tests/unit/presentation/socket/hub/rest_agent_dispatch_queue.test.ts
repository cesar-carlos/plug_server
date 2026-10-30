import { actionIoQueueSignal } from "../../../../../src/application/agent_commands/action_io_deadline";
import { bridgeSingleCommandSchema } from "../../../../../src/shared/validators/agent_command";
import type * as EnvModule from "../../../../../src/shared/config/env";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return {
    ...mod,
    env: {
      ...mod.env,
      socketRestAgentMaxInflight: 32,
      socketRestAgentMaxQueue: 64,
      socketRestAgentQueueWaitMs: 200,
    },
  };
});

import {
  acquireRestAgentDispatchSlot,
  getRestAgentDispatchQueueMetricsSnapshot,
  resetRestAgentDispatchQueue,
  wireRestAgentDispatchQueueMetrics,
} from "../../../../../src/presentation/socket/hub/relay/rest_agent_dispatch_queue";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";

describe("rest_agent_dispatch_queue", () => {
  it("removes an I/O waiter at its deadline without claiming a released slot later", async () => {
    const command = bridgeSingleCommandSchema.parse({
      method: "agent.action.findExecution",
      id: "i",
      params: { action_id: "a", idempotency_key: "k" },
    });
    const releases: Array<() => void> = [];
    try {
      for (let i = 0; i < 32; i++)
        releases.push(await acquireRestAgentDispatchSlot("io-saturated"));
      const deadlineSignal = actionIoQueueSignal(command, 5, performance.now());
      const waiting = acquireRestAgentDispatchSlot("io-saturated", deadlineSignal);
      expect(getRestAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(1);
      await expect(waiting).rejects.toThrow();
      expect(deadlineSignal?.aborted).toBe(true);
      expect(getRestAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(0);
      expect(getRestAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(32);
    } finally {
      releases.forEach((release) => release());
    }
    expect(getRestAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
    const next = await acquireRestAgentDispatchSlot("io-saturated");
    next();
    expect(getRestAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(0);
  });

  afterEach(() => {
    resetRestAgentDispatchQueue(serviceUnavailable("test reset"));
    wireRestAgentDispatchQueueMetrics(() => {});
  });

  it("getRestAgentDispatchQueueMetricsSnapshot reflects inflight after acquire", async () => {
    wireRestAgentDispatchQueueMetrics(() => {});
    const release = await acquireRestAgentDispatchSlot("agent-a");
    const snap = getRestAgentDispatchQueueMetricsSnapshot();
    expect(snap.totalInflight).toBe(1);
    expect(snap.totalQueuedWaiters).toBe(0);
    expect(snap.agentsWithQueuedWaiters).toBe(0);
    expect(snap.maxQueueDepthPerAgent).toBe(0);
    release();
    const after = getRestAgentDispatchQueueMetricsSnapshot();
    expect(after.totalInflight).toBe(0);
  });
});
