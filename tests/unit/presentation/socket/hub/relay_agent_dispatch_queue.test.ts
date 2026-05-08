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
} from "../../../../../src/presentation/socket/hub/relay_agent_dispatch_queue";
import { serviceUnavailable } from "../../../../../src/shared/errors/http_errors";

describe("relay_agent_dispatch_queue", () => {
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

  it("is safe to release a slot more than once", async () => {
    const release = await acquireRelayAgentDispatchSlot("agent-d");
    release();
    release();
    expect(getRelayAgentDispatchQueueMetricsSnapshot().totalInflight).toBe(0);
  });
});
