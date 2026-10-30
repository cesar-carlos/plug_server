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
      socketRelayAgentMaxInflight: 1,
      socketRelayAgentMaxQueue: 1,
      socketRelayAgentQueueWaitMs: 25,
    },
  };
});

import {
  acquireRelayAgentDispatchSlot,
  getRelayAgentDispatchQueueMetricsSnapshot,
  resetRelayAgentDispatchQueue,
} from "../../../../../src/presentation/socket/hub/relay/relay_agent_dispatch_queue";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";

describe("relay_agent_dispatch_queue", () => {
  it("removes an I/O waiter at its deadline without claiming a released slot later", async () => {
    const command = bridgeSingleCommandSchema.parse({
      method: "agent.action.findExecution",
      id: "i",
      params: { action_id: "a", idempotency_key: "k" },
    });
    const releases: Array<() => void> = [];
    try {
      for (let i = 0; i < 1; i++)
        releases.push(await acquireRelayAgentDispatchSlot("io-saturated"));
      const deadlineSignal = actionIoQueueSignal(command, 5, performance.now());
      const waiting = acquireRelayAgentDispatchSlot("io-saturated", deadlineSignal);
      expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(1);
      await expect(waiting).rejects.toThrow();
      expect(deadlineSignal?.aborted).toBe(true);
      expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(0);
      expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(1);
    } finally {
      releases.forEach((release) => release());
    }
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
    const next = await acquireRelayAgentDispatchSlot("io-saturated");
    next();
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRelayAgentDispatchQueue(serviceUnavailable("test reset"));
  });

  it("queues FIFO and releases the next waiter", async () => {
    const releaseFirst = await acquireRelayAgentDispatchSlot("agent-a");
    const second = acquireRelayAgentDispatchSlot("agent-a");

    await vi.waitFor(() => {
      expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(1);
    });
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(1);

    releaseFirst();
    const releaseSecond = await second;

    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(1);
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(0);

    releaseSecond();
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
  });

  it("rejects when the per-agent queue is full", async () => {
    const releaseFirst = await acquireRelayAgentDispatchSlot("agent-b");
    const second = acquireRelayAgentDispatchSlot("agent-b");

    await vi.waitFor(() => {
      expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(1);
    });

    await expect(acquireRelayAgentDispatchSlot("agent-b")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retry_after_ms: 25 },
    });
    expect(getRelayAgentDispatchQueueMetricsSnapshot().queueFullRejected).toBe(1);

    releaseFirst();
    const releaseSecond = await second;
    releaseSecond();
  });

  it("rejects queued waiters after queue wait timeout", async () => {
    vi.useFakeTimers();

    const releaseFirst = await acquireRelayAgentDispatchSlot("agent-c");
    const second = acquireRelayAgentDispatchSlot("agent-c");
    const observedRejection = expect(second).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retry_after_ms: 25 },
    });

    await vi.advanceTimersByTimeAsync(26);

    await observedRejection;
    expect(getRelayAgentDispatchQueueMetricsSnapshot().queueWaitTimeoutRejected).toBe(1);

    releaseFirst();
  });

  it("removes queued waiters when the consumer aborts before dispatch", async () => {
    const releaseFirst = await acquireRelayAgentDispatchSlot("agent-abort");
    const abortController = new AbortController();
    const second = acquireRelayAgentDispatchSlot("agent-abort", abortController.signal);

    await vi.waitFor(() => {
      expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(1);
    });

    abortController.abort();

    await expect(second).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalQueuedWaiters).toBe(0);

    releaseFirst();
  });

  it("is safe to release a slot more than once", async () => {
    const release = await acquireRelayAgentDispatchSlot("agent-d");
    release();
    release();
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
  });
});
