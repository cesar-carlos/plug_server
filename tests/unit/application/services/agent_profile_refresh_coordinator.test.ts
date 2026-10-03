import { describe, expect, it, vi } from "vitest";
import { AgentProfileRefreshCoordinator } from "../../../../src/application/services/agent_profile_refresh_coordinator";
import { AgentSnapshotRefresher } from "../../../../src/application/services/agent_snapshot_refresher";
import { Agent } from "../../../../src/domain/entities/agent.entity";

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const agent = (id: string): Agent => Agent.create({ agentId: id, name: id });
const turn = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const online = async (ids: readonly string[]): Promise<ReadonlySet<string>> => new Set(ids);

describe("shared profile refresh admission", () => {
  it("revalidates presence after FIFO waiting and skips dispatch for disconnected agents", async () => {
    let connected = new Set(["a", "b"]);
    const presence = vi.fn(
      async (ids: readonly string[]) => new Set(ids.filter((id) => connected.has(id))),
    );
    const coordinator = new AgentProfileRefreshCoordinator(1, presence);
    const pending = deferred<Agent>();
    const first = coordinator.submit("a", () => pending.promise);
    const run = vi.fn(async () => agent("b"));
    const queued = coordinator.submit("b", run);
    await turn();
    connected = new Set(["a"]);
    pending.resolve(agent("a"));
    await first.result;
    expect(await queued.result).toEqual({ kind: "offline" });
    expect(presence.mock.calls).toEqual([[["a"]], [["b"]]]);
    expect(run).not.toHaveBeenCalled();
    expect(coordinator.getMetrics().active).toBe(0);
  });
  it("shares capacity between lists/details and deduplicates list work before FIFO admission", async () => {
    const coordinator = new AgentProfileRefreshCoordinator(1, online);
    const a = deferred<Agent>(),
      b = deferred<Agent>();
    const run = vi.fn((id: string) => (id === "a" ? a.promise : b.promise));
    const refresher = new AgentSnapshotRefresher({ findById: vi.fn() }, coordinator, {
      resolveOnlineAgentIds: online,
      refreshAgentProfile: run,
    });
    const list = refresher.refreshListItems("c", [{ agent: agent("a") }]);
    const duplicate = refresher.refreshListItems("d", [{ agent: agent("a") }]);
    await turn();
    const detail = refresher.resolvePreferredSnapshot("c", "b", agent("b"));
    await turn();
    expect(run.mock.calls).toEqual([["a"]]);
    expect(coordinator.getMetrics()).toMatchObject({ active: 1, waiting: 1 });
    a.resolve(agent("a"));
    await turn();
    expect(run.mock.calls).toEqual([["a"], ["b"]]);
    b.resolve(agent("b"));
    await Promise.all([list, duplicate, detail]);
    await refresher.refreshListItems("c", [{ agent: agent("a") }]);
    await refresher.resolvePreferredSnapshot("c", "b", agent("b"));
    expect(run).toHaveBeenCalledTimes(3);
    await refresher.close();
    expect(refresher.getMetrics()).toMatchObject({
      active: 0,
      waiting: 0,
      cacheEntries: 0,
      cacheExpirations: 0,
    });
  });

  it("batches fresh presence for available slots and preserves FIFO", async () => {
    const presence = vi.fn(online),
      runOrder: string[] = [],
      pending = deferred<Agent>();
    const coordinator = new AgentProfileRefreshCoordinator(2, presence);
    const jobs = ["a", "b", "c"].map((id) =>
      coordinator.submit(id, async () => {
        runOrder.push(id);
        return id === "a" ? pending.promise : agent(id);
      }),
    );
    const completions = jobs.map((job) =>
      job.wait(job.result, undefined, () => ({ kind: "cancelled" as const })),
    );
    await turn();
    expect(presence.mock.calls[0]).toEqual([["a", "b"]]);
    expect(runOrder).toEqual(["a", "b", "c"]);
    pending.resolve(agent("a"));
    await Promise.all(completions);
    coordinator.beginShutdown();
    await coordinator.drain();
  });

  it("removes abandoned queued work, but keeps shared work for other HTTP waiters", async () => {
    const coordinator = new AgentProfileRefreshCoordinator(1, online),
      first = deferred<Agent>(),
      second = deferred<Agent>();
    const blocker = coordinator.submit("a", () => first.promise);
    const shared = coordinator.submit("b", () => second.promise);
    const abandonedRun = vi.fn(async () => agent("c"));
    const abandoned = coordinator.submit("c", abandonedRun);
    const controller = new AbortController();
    const waiter1 = shared.wait(shared.result, controller.signal, () => ({
      kind: "cancelled" as const,
    }));
    const waiter2 = shared.wait(shared.result, undefined, () => ({ kind: "cancelled" as const }));
    const waiter3 = abandoned.wait(abandoned.result, controller.signal, () => ({
      kind: "cancelled" as const,
    }));
    await turn();
    controller.abort();
    await Promise.all([waiter1, waiter3]);
    expect(coordinator.getMetrics().waiting).toBe(1);
    first.resolve(agent("a"));
    await blocker.result;
    await turn();
    second.resolve(agent("b"));
    await waiter2;
    expect(abandonedRun).not.toHaveBeenCalled();
    expect(coordinator.getMetrics().active).toBe(0);
  });

  it("releases failed refresh slots before persisted fallback and propagates presence failures", async () => {
    const fallback = deferred<Agent>(),
      coordinator = new AgentProfileRefreshCoordinator(1, online);
    const run = vi.fn(async (id: string) => {
      if (id === "a") throw new Error("rpc");
      return agent(id);
    });
    const refresher = new AgentSnapshotRefresher(
      { findById: () => fallback.promise },
      coordinator,
      { refreshAgentProfile: run },
    );
    const first = refresher.resolvePreferredSnapshot("c", "a", agent("a"));
    const second = refresher.resolvePreferredSnapshot("c", "b", agent("b"));
    await turn();
    await second;
    expect(run).toHaveBeenCalledTimes(2);
    expect(coordinator.getMetrics().active).toBe(0);
    fallback.resolve(agent("a"));
    await first;
    await refresher.close();
    const failing = new AgentProfileRefreshCoordinator(4, async () => {
      throw new Error("redis");
    });
    const strict = new AgentSnapshotRefresher({ findById: vi.fn() }, failing, {
      refreshAgentProfile: run,
    });
    await expect(strict.resolvePreferredSnapshot("c", "a", agent("a"))).rejects.toThrow("redis");
    await strict.close();
  });

  it("supports unlimited independent instances and drains only admitted work during shutdown", async () => {
    const limited = new AgentProfileRefreshCoordinator(1, online),
      unlimited = new AgentProfileRefreshCoordinator(0, online);
    const pending = deferred<Agent>(),
      run = vi.fn(() => pending.promise);
    const active = limited.submit("a", run),
      queuedRun = vi.fn(() => pending.promise),
      queued = limited.submit("b", queuedRun);
    const other = ["c", "d", "e"].map((id) => unlimited.submit(id, run));
    await turn();
    expect(limited.getMetrics().active).toBe(1);
    expect(unlimited.getMetrics().active).toBe(3);
    limited.beginShutdown();
    expect(await queued.result).toEqual({ kind: "cancelled" });
    expect(await limited.submit("late", run).result).toEqual({ kind: "cancelled" });
    let drained = false;
    const drain = limited.drain().then(() => {
      drained = true;
    });
    await turn();
    expect(drained).toBe(false);
    pending.resolve(agent("a"));
    await Promise.all([active.result, ...other.map((job) => job.result), drain]);
    expect(queuedRun).not.toHaveBeenCalled();
  });

  it("does not cache an old completion after shutdown and serves queued work by persisted fallback", async () => {
    const pending = deferred<Agent>(),
      coordinator = new AgentProfileRefreshCoordinator(1, online);
    const persisted = vi.fn(async (id: string) => agent(id));
    const refresher = new AgentSnapshotRefresher({ findById: persisted }, coordinator, {
      resolveOnlineAgentIds: online,
      refreshAgentProfile: () => pending.promise,
    });
    const list = refresher.refreshListItems("c", [{ agent: agent("a") }, { agent: agent("b") }]);
    await turn();
    refresher.beginShutdown();
    await turn();
    expect(persisted).toHaveBeenCalledWith("b");
    pending.resolve(agent("a"));
    await list;
    await refresher.close();
    expect(refresher.getMetrics().cacheEntries).toBe(0);
  });
});
