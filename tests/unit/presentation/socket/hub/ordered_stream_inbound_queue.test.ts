import { describe, expect, it, vi } from "vitest";

import { createOrderedStreamInboundQueue } from "../../../../../src/presentation/socket/hub/relay/ordered_stream_inbound_queue";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

  it("cleanup() drops a socket tail and reset() clears everything (no throw)", async () => {
    const queue = createOrderedStreamInboundQueue();
    const ran: string[] = [];

    queue.enqueue("socket-a", async () => {
      ran.push("a");
    });
    queue.cleanup("socket-a");
    queue.enqueue("socket-b", async () => {
      ran.push("b");
    });
    queue.reset();

    // Work already enqueued still resolves; cleanup/reset only drop the
    // bookkeeping tail used to chain *future* work.
    await tick();
    await vi.waitFor(() => expect(ran.sort()).toEqual(["a", "b"]));
    expect(() => queue.reset()).not.toThrow();
  });
});
