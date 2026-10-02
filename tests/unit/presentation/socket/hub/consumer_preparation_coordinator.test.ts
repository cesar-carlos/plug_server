import { describe, expect, it, vi } from "vitest";
import { ConsumerPreparationCoordinator } from "../../../../../src/presentation/socket/hub/scheduling/consumer_preparation_coordinator";

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("consumer preparation scheduling", () => {
  it("bounds active work per socket and hub, with FIFO and round robin ready lanes", async () => {
    const coordinator = new ConsumerPreparationCoordinator({ perSocket: 1, perHub: 1 });
    const jobs = Array.from({ length: 5 }, deferred);
    const order: string[] = [];
    const enqueue = (socket: string, index: number): Promise<unknown> =>
      coordinator.run(socket, { payload: Buffer.alloc(8) }, async () => {
        order.push(`${socket}${index}`);
        await jobs[index]!.promise;
        return index;
      });
    const results = [
      enqueue("a", 0),
      enqueue("a", 1),
      enqueue("a", 2),
      enqueue("b", 3),
      enqueue("b", 4),
    ];
    await Promise.resolve();
    expect(order).toEqual(["a0"]);
    expect(coordinator.getMetrics()).toMatchObject({ active: 1, waiting: 4, waitingBytes: 32 });
    jobs[0]!.resolve();
    await results[0];
    await Promise.resolve();
    expect(order).toEqual(["a0", "b3"]);
    jobs[3]!.resolve();
    await results[3];
    await Promise.resolve();
    expect(order).toEqual(["a0", "b3", "a1"]);
    jobs[1]!.resolve();
    await results[1];
    await Promise.resolve();
    expect(order).toEqual(["a0", "b3", "a1", "b4"]);
    jobs[4]!.resolve();
    await results[4];
    jobs[2]!.resolve();
    await Promise.all(results);
    expect(coordinator.getMetrics()).toMatchObject({
      active: 0,
      waiting: 0,
      waitingBytes: 0,
      waitCount: 5,
    });
    expect(coordinator.getMetrics().waitSumMs).toBeGreaterThanOrEqual(0);
  });

  it("enforces the socket limit independently of available hub slots", async () => {
    const coordinator = new ConsumerPreparationCoordinator({ perSocket: 2, perHub: 3 });
    const gate = deferred();
    const work = vi.fn(() => gate.promise);
    const results = [
      coordinator.run("a", null, work),
      coordinator.run("a", null, work),
      coordinator.run("a", null, work),
      coordinator.run("b", null, work),
    ];
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(3);
    expect(coordinator.getMetrics()).toMatchObject({ active: 3, waiting: 1 });
    gate.resolve();
    await Promise.all(results);
    expect(work).toHaveBeenCalledTimes(4);
  });

  it.each([
    { perSocket: 0, perHub: 0 },
    { perSocket: 0, perHub: 5 },
    { perSocket: 5, perHub: 0 },
  ])("supports disabled dimensions: %o", async (limits) => {
    const coordinator = new ConsumerPreparationCoordinator(limits);
    const gate = deferred();
    const results = Array.from({ length: 5 }, () => coordinator.run("a", null, () => gate.promise));
    expect(coordinator.getMetrics()).toMatchObject({ active: 5, waiting: 0 });
    gate.resolve();
    await Promise.all(results);
  });

  it("releases slots on thrown or rejected preparation and preserves the error", async () => {
    const coordinator = new ConsumerPreparationCoordinator({ perSocket: 1, perHub: 1 });
    const first = coordinator.run("a", null, () => {
      throw new Error("invalid signature");
    });
    const next = coordinator.run("a", null, async () => "valid");
    await expect(first).rejects.toThrow("invalid signature");
    await expect(next).resolves.toEqual({ cancelled: false, value: "valid" });
    expect(coordinator.getMetrics().active).toBe(0);
  });

  it("cancels waiting work and suppresses active results after socket-id reuse", async () => {
    const coordinator = new ConsumerPreparationCoordinator({ perSocket: 1, perHub: 1 });
    const gate = deferred();
    const active = coordinator.run("a", null, () => gate.promise);
    const waitingWork = vi.fn();
    const waiting = coordinator.run("a", { payload: Buffer.alloc(12) }, waitingWork);
    coordinator.cancelSocket("a");
    await expect(waiting).resolves.toEqual({ cancelled: true });
    expect(coordinator.getMetrics()).toMatchObject({ active: 1, waiting: 0, waitingBytes: 0 });
    const replacement = coordinator.run("a", null, () => "new session");
    gate.resolve();
    await expect(active).resolves.toEqual({ cancelled: true });
    await expect(replacement).resolves.toEqual({ cancelled: false, value: "new session" });
    expect(waitingWork).not.toHaveBeenCalled();
  });

  it("closes admission, cancels queued work, and waits only for active preparation", async () => {
    const coordinator = new ConsumerPreparationCoordinator({ perSocket: 1, perHub: 1 });
    const gate = deferred();
    const active = coordinator.run("a", null, () => gate.promise);
    const waiting = coordinator.run("b", null, vi.fn());
    let closed = false;
    const close = coordinator.close().then(() => {
      closed = true;
    });
    await expect(waiting).resolves.toEqual({ cancelled: true });
    await expect(coordinator.run("c", null, vi.fn())).resolves.toEqual({ cancelled: true });
    expect(closed).toBe(false);
    gate.resolve();
    await active;
    await close;
    expect(coordinator.getMetrics()).toMatchObject({ active: 0, waiting: 0, waitingBytes: 0 });
  });

  it("isolates capacity and shutdown between hubs", async () => {
    const first = new ConsumerPreparationCoordinator({ perSocket: 1, perHub: 1 });
    const second = new ConsumerPreparationCoordinator({ perSocket: 1, perHub: 1 });
    const gate = deferred();
    const active = first.run("same", null, () => gate.promise);
    await expect(second.run("same", null, () => 2)).resolves.toEqual({
      cancelled: false,
      value: 2,
    });
    await second.close();
    expect(first.getMetrics().active).toBe(1);
    gate.resolve();
    await active;
    await first.close();
  });
});
