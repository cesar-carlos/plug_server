import { describe, expect, it, vi } from "vitest";

import { createOrderedStreamInboundQueue } from "../../../../../src/presentation/socket/hub/relay/ordered_stream_inbound_queue";

describe("createOrderedStreamInboundQueue", () => {
  it("runs work for the same socket strictly in enqueue order", async () => {
    const queue = createOrderedStreamInboundQueue();
    const order: number[] = [];

    queue.enqueue("socket-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(1);
    });
    queue.enqueue("socket-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(2);
    });
    queue.enqueue("socket-a", async () => {
      order.push(3);
    });

    await vi.waitFor(() => expect(order).toEqual([1, 2, 3]));
  });

  it("isolates failures: a rejected work does not break the chain for later work", async () => {
    const queue = createOrderedStreamInboundQueue();
    const order: string[] = [];

    queue.enqueue("socket-a", async () => {
      order.push("ok-1");
    });
    queue.enqueue("socket-a", async () => {
      throw new Error("boom");
    });
    queue.enqueue("socket-a", async () => {
      order.push("ok-2");
    });

    await vi.waitFor(() => expect(order).toEqual(["ok-1", "ok-2"]));
  });

  it("keeps separate ordering chains per socket", async () => {
    const queue = createOrderedStreamInboundQueue();
    const aOrder: number[] = [];
    const bOrder: number[] = [];

    queue.enqueue("socket-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      aOrder.push(1);
    });
    queue.enqueue("socket-b", async () => {
      bOrder.push(1);
    });
    queue.enqueue("socket-a", async () => {
      aOrder.push(2);
    });

    await vi.waitFor(() => {
      expect(aOrder).toEqual([1, 2]);
      expect(bOrder).toEqual([1]);
    });
  });

  it("cleanup() skips not-yet-started work for that socket", async () => {
    const queue = createOrderedStreamInboundQueue();
    const ran: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.enqueue("socket-a", async () => {
      ran.push("a1-start");
      await firstGate;
      ran.push("a1-end");
    });
    queue.enqueue("socket-a", async () => {
      ran.push("a2");
    });

    await vi.waitFor(() => expect(ran).toContain("a1-start"));
    queue.cleanup("socket-a");
    releaseFirst();

    await vi.waitFor(() => expect(ran).toEqual(["a1-start", "a1-end"]));
    expect(ran).not.toContain("a2");
  });

  it("cleanup() prunes generation after the abandoned chain settles", async () => {
    const queue = createOrderedStreamInboundQueue();
    const ran: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.enqueue("socket-a", async () => {
      await firstGate;
    });
    queue.enqueue("socket-a", async () => {
      ran.push("should-skip");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.cleanup("socket-a");
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));

    queue.enqueue("socket-a", async () => {
      ran.push("after-prune");
    });
    await vi.waitFor(() => expect(ran).toContain("after-prune"));
    expect(ran).not.toContain("should-skip");
  });

  it("cleanup() and reset() are safe no-ops on empty state", () => {
    const queue = createOrderedStreamInboundQueue();
    expect(() => {
      queue.cleanup("missing");
      queue.reset();
      queue.reset();
    }).not.toThrow();
  });
});
