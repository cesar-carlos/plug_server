import { afterEach, describe, expect, it } from "vitest";

import {
  enqueueRelayOutbound,
  getRelayOutboundQueueMetricsSnapshot,
  resetRelayOutboundQueueState,
} from "../../../../../src/presentation/socket/hub/relay_outbound_queue";

afterEach(() => {
  resetRelayOutboundQueueState();
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("relay_outbound_queue", () => {
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
    const m = getRelayOutboundQueueMetricsSnapshot();
    expect(m.jobsFailedTotal).toBe(1);
    expect(m.jobsFinishedTotal).toBe(3);
  });

  it("records duration metrics for completed jobs", async () => {
    enqueueRelayOutbound("x", async () => {
      await new Promise<void>((r) => setTimeout(r, 15));
    });
    await new Promise<void>((r) => setTimeout(r, 40));
    const m = getRelayOutboundQueueMetricsSnapshot();
    expect(m.jobsFinishedTotal).toBe(1);
    expect(m.jobsFailedTotal).toBe(0);
    expect(m.jobDurationSumMs).toBeGreaterThanOrEqual(1);
    expect(m.jobDurationMaxMs).toBeGreaterThanOrEqual(1);
    expect(m.jobDurationAvgMs).toBeGreaterThan(0);
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
});
