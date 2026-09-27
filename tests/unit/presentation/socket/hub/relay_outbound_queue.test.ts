import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  enqueueRelayOutbound,
  getRelayOutboundQueueMetricsSnapshot,
  getRelayOutboundQueueOverloadState,
  resetRelayOutboundQueueState,
  sweepRelayOutboundQueueState,
} from "../../../../../src/presentation/socket/hub/relay/relay_outbound_queue";

afterEach(() => {
  vi.useRealTimers();
  resetRelayOutboundQueueState();
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("relay_outbound_queue", () => {
  it("does not sweep a request chain while a job is still running", () => {
    enqueueRelayOutbound("req-zombie", async () => {
      await new Promise<void>(() => undefined);
    });

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + env.socketRelayOutboundTailStaleMs + 1);

    expect(sweepRelayOutboundQueueState()).toBe(0);

    const snapshot = getRelayOutboundQueueMetricsSnapshot();
    expect(snapshot.orphanedTailsSweptTotal).toBe(0);
    expect(snapshot.inflightRequestIds).toBe(1);

    nowSpy.mockRestore();
  });

  it("runs jobs for the same requestId in enqueue order", async () => {
    const order: number[] = [];
    enqueueRelayOutbound("r1", async () => {
      order.push(1);
    });
    enqueueRelayOutbound("r1", async () => {
      order.push(2);
    });
    enqueueRelayOutbound("r1", async () => {
      order.push(3);
    });
    await flush();
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps ordering after a stale sweep attempt", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: number[] = [];

    enqueueRelayOutbound("r1", async () => {
      order.push(1);
      await firstGate;
      order.push(2);
    });
    enqueueRelayOutbound("r1", async () => {
      order.push(3);
    });

    await flush();
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + env.socketRelayOutboundTailStaleMs + 1);

    expect(sweepRelayOutboundQueueState()).toBe(0);

    enqueueRelayOutbound("r1", async () => {
      order.push(4);
    });

    releaseFirst();
    await flush();
    await flush();

    expect(order).toEqual([1, 2, 3, 4]);
    nowSpy.mockRestore();
  });

  it("allows concurrent chains for different requestIds", async () => {
    const order: string[] = [];
    enqueueRelayOutbound("a", async () => {
      order.push("a1");
      await new Promise<void>((r) => setImmediate(r));
      order.push("a2");
    });
    enqueueRelayOutbound("b", async () => {
      order.push("b1");
    });
    await flush();
    await flush();
    expect(new Set(order)).toEqual(new Set(["a1", "a2", "b1"]));
    expect(order.indexOf("a2")).toBeGreaterThan(order.indexOf("a1"));
  });

  it("continues the chain after a failing job", async () => {
    const order: number[] = [];
    enqueueRelayOutbound("r1", async () => {
      order.push(1);
    });
    enqueueRelayOutbound("r1", async () => {
      order.push(2);
      throw new Error("boom");
    });
    enqueueRelayOutbound("r1", async () => {
      order.push(3);
    });
    await flush();
    expect(order).toEqual([1, 2, 3]);
    const metrics = getRelayOutboundQueueMetricsSnapshot();
    expect(metrics.jobsFailedTotal).toBe(1);
    expect(metrics.jobsFinishedTotal).toBe(3);
  });

  it("records duration metrics for completed jobs", async () => {
    enqueueRelayOutbound("x", async () => {
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    await new Promise<void>((r) => setTimeout(r, 40));
    const metrics = getRelayOutboundQueueMetricsSnapshot();
    expect(metrics.jobsFinishedTotal).toBe(1);
    expect(metrics.jobsFailedTotal).toBe(0);
    expect(metrics.jobDurationSumMs).toBeGreaterThanOrEqual(1);
    expect(metrics.jobDurationMaxMs).toBeGreaterThanOrEqual(1);
    expect(metrics.jobDurationAvgMs).toBeGreaterThan(0);
  });

  it("exposes inflightRequestIds while work is pending", async () => {
    let continueSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      continueSecond = resolve;
    });

    enqueueRelayOutbound("p1", async () => {
      await secondStarted;
    });
    enqueueRelayOutbound("p1", async () => {
      /* no-op */
    });

    await new Promise<void>((r) => setImmediate(r));
    expect(getRelayOutboundQueueMetricsSnapshot().inflightRequestIds).toBeGreaterThanOrEqual(1);

    continueSecond();
    await flush();
    expect(getRelayOutboundQueueMetricsSnapshot().inflightRequestIds).toBe(0);
  });

  it("reports overload when backlog crosses threshold", () => {
    /**
     * The "Generous profile" production `.env` sets
     * `SOCKET_RELAY_OUTBOUND_OVERLOAD_BACKLOG=0` (shedding disabled). To keep
     * this contract test independent of the active profile, we temporarily
     * pin the threshold to a small positive value and restore it on exit.
     */
    const originalThreshold = env.socketRelayOutboundOverloadBacklog;
    const testThreshold = 5;
    Object.defineProperty(env, "socketRelayOutboundOverloadBacklog", {
      value: testThreshold,
      configurable: true,
      writable: true,
    });
    try {
      for (let index = 0; index < testThreshold + 1; index += 1) {
        enqueueRelayOutbound(`req-${index}`, async () => {
          await new Promise<void>(() => undefined);
        });
      }

      const overload = getRelayOutboundQueueOverloadState();
      expect(overload.overloaded).toBe(true);
      expect(overload.reason).toBe("backlog");
      expect(overload.snapshot.backlog).toBeGreaterThanOrEqual(testThreshold);
    } finally {
      Object.defineProperty(env, "socketRelayOutboundOverloadBacklog", {
        value: originalThreshold,
        configurable: true,
        writable: true,
      });
    }
  });

  it("clears overload only after backlog drops below exit threshold", async () => {
    const originalEnter = env.socketRelayOutboundOverloadBacklog;
    const originalExit = env.socketRelayOutboundOverloadBacklogExit;
    const originalP95 = env.socketRelayOutboundOverloadP95Ms;
    const testEnter = 10;
    const testExit = 6;
    Object.defineProperty(env, "socketRelayOutboundOverloadBacklog", {
      value: testEnter,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(env, "socketRelayOutboundOverloadBacklogExit", {
      value: testExit,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(env, "socketRelayOutboundOverloadP95Ms", {
      value: 0,
      configurable: true,
      writable: true,
    });

    const releases: Array<() => void> = [];
    try {
      for (let index = 0; index < testEnter; index += 1) {
        enqueueRelayOutbound(`req-hyst-${index}`, async () => {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        });
      }
      await flush();
      expect(getRelayOutboundQueueOverloadState().overloaded).toBe(true);

      releases.shift()?.();
      await flush();
      expect(getRelayOutboundQueueOverloadState().overloaded).toBe(true);

      while (releases.length > 0) {
        releases.shift()?.();
        await flush();
      }
      expect(getRelayOutboundQueueOverloadState().overloaded).toBe(false);
    } finally {
      Object.defineProperty(env, "socketRelayOutboundOverloadBacklog", {
        value: originalEnter,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(env, "socketRelayOutboundOverloadBacklogExit", {
        value: originalExit,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(env, "socketRelayOutboundOverloadP95Ms", {
        value: originalP95,
        configurable: true,
        writable: true,
      });
    }
  });

  it("sheds new work when per-consumer pending bytes exceed the cap", async () => {
    const original = env.socketRelayOutboundMaxPendingBytesPerConsumer;
    Object.defineProperty(env, "socketRelayOutboundMaxPendingBytesPerConsumer", {
      value: 10,
      configurable: true,
    });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = enqueueRelayOutbound(
        "req-bytes",
        async () => {
          await gate;
        },
        { consumerSocketId: "c1", pendingBytes: 8 },
      );
      expect(first.ok).toBe(true);
      const shed = enqueueRelayOutbound("req-bytes-2", () => undefined, {
        consumerSocketId: "c1",
        pendingBytes: 8,
      });
      expect(shed.ok).toBe(false);
      if (!shed.ok) {
        expect(shed.reason).toBe("shed");
      }
      const other = enqueueRelayOutbound("req-other", () => undefined, {
        consumerSocketId: "c2",
        pendingBytes: 8,
      });
      expect(other.ok).toBe(true);
      release();
      await flush();
    } finally {
      Object.defineProperty(env, "socketRelayOutboundMaxPendingBytesPerConsumer", {
        value: original,
        configurable: true,
      });
    }
  });

  it("returns hard when pending bytes exceed twice the consumer cap", () => {
    const original = env.socketRelayOutboundMaxPendingBytesPerConsumer;
    Object.defineProperty(env, "socketRelayOutboundMaxPendingBytesPerConsumer", {
      value: 10,
      configurable: true,
    });
    try {
      const first = enqueueRelayOutbound("req-hard-1", async () => new Promise(() => undefined), {
        consumerSocketId: "c-hard",
        pendingBytes: 8,
      });
      expect(first.ok).toBe(true);
      const hard = enqueueRelayOutbound("req-hard-2", () => undefined, {
        consumerSocketId: "c-hard",
        pendingBytes: 20,
      });
      expect(hard.ok).toBe(false);
      if (!hard.ok) {
        expect(hard.reason).toBe("hard");
      }
    } finally {
      Object.defineProperty(env, "socketRelayOutboundMaxPendingBytesPerConsumer", {
        value: original,
        configurable: true,
      });
    }
  });

  it("keeps an in-flight stream until the hard cap and clears state on reset", async () => {
    const original = env.socketRelayOutboundMaxPendingBytesPerConsumer;
    Object.defineProperty(env, "socketRelayOutboundMaxPendingBytesPerConsumer", {
      value: 10,
      configurable: true,
    });
    try {
      const held = enqueueRelayOutbound("req-hold", async () => new Promise(() => undefined), {
        consumerSocketId: "c-age",
        pendingBytes: 8,
      });
      expect(held.ok).toBe(true);
      expect(getRelayOutboundQueueMetricsSnapshot().oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
      const continued = enqueueRelayOutbound("req-hold", () => undefined, {
        consumerSocketId: "c-age",
        pendingBytes: 8,
        shedPolicy: "allow",
      });
      expect(continued.ok).toBe(true);
      const healthy = enqueueRelayOutbound("req-healthy", () => undefined, {
        consumerSocketId: "c-other",
        pendingBytes: 8,
      });
      expect(healthy.ok).toBe(true);
      const hard = enqueueRelayOutbound("req-hold", () => undefined, {
        consumerSocketId: "c-age",
        pendingBytes: 30,
        shedPolicy: "allow",
      });
      expect(hard.ok).toBe(false);
      if (!hard.ok) {
        expect(hard.reason).toBe("hard");
      }
    } finally {
      Object.defineProperty(env, "socketRelayOutboundMaxPendingBytesPerConsumer", {
        value: original,
        configurable: true,
      });
    }
    resetRelayOutboundQueueState();
    const afterReset = enqueueRelayOutbound("req-hold", () => undefined, {
      consumerSocketId: "c-age",
      pendingBytes: 8,
    });
    expect(afterReset.ok).toBe(true);
    await flush();
  });

  it("does not block a second request while the first request is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    enqueueRelayOutbound("stream-a", async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    enqueueRelayOutbound("stream-b", async () => {
      order.push("b");
    });
    await flush();
    expect(order).toEqual(["a-start", "b"]);
    release();
    await flush();
    expect(order).toEqual(["a-start", "b", "a-end"]);
  });
});
