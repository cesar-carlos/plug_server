import type { Agent } from "../../domain/entities/agent.entity";

export type RefreshOutcome =
  | { readonly kind: "success"; readonly agent: Agent }
  | { readonly kind: "offline" | "cancelled" }
  | { readonly kind: "presence_error" | "refresh_error"; readonly error: unknown };

export interface ProfileRefreshWork {
  readonly result: Promise<RefreshOutcome>;
  wait<T>(completion: Promise<T>, signal: AbortSignal | undefined, cancelled: () => T): Promise<T>;
}

export interface ProfileRefreshMetrics {
  readonly active: number;
  readonly waiting: number;
  readonly waitCount: number;
  readonly waitSumMs: number;
  readonly waitMaxMs: number;
  readonly cancellations: number;
}

interface CompletionWaiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface Job {
  readonly agentId: string;
  readonly queuedAtMs: number;
  readonly settle: (outcome: RefreshOutcome) => void;
  run: (() => Promise<Agent>) | undefined;
  state: "queued" | "active" | "settled";
  interested: number;
  readonly waitGroups: Map<Promise<unknown>, Set<CompletionWaiter>>;
}

/** Instance-owned FIFO admission; the slot ends before persisted fallback reads. */
export class AgentProfileRefreshCoordinator {
  private readonly queue = new Set<Job>();
  private readonly drainWaiters = new Set<() => void>();
  private active = 0;
  private admitting = true;
  private scheduled = false;
  private waitCount = 0;
  private waitSumMs = 0;
  private waitMaxMs = 0;
  private cancellations = 0;

  constructor(
    private readonly concurrency: number,
    private readonly resolveOnline: (agentIds: readonly string[]) => Promise<ReadonlySet<string>>,
  ) {}

  submit(agentId: string, run: () => Promise<Agent>): ProfileRefreshWork {
    let settle!: (outcome: RefreshOutcome) => void;
    const result = new Promise<RefreshOutcome>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      agentId,
      run,
      settle,
      queuedAtMs: performance.now(),
      state: "queued",
      interested: 0,
      waitGroups: new Map(),
    };
    if (this.admitting) {
      this.queue.add(job);
      this.schedule();
    } else this.finish(job, { kind: "cancelled" });
    return {
      result,
      wait: <T>(
        completion: Promise<T>,
        signal: AbortSignal | undefined,
        cancelled: () => T,
      ): Promise<T> => this.wait(job, completion, signal, cancelled),
    };
  }

  private wait<T>(
    job: Job,
    completion: Promise<T>,
    signal: AbortSignal | undefined,
    cancelled: () => T,
  ): Promise<T> {
    let group = job.waitGroups.get(completion);
    if (group === undefined) {
      group = new Set();
      job.waitGroups.set(completion, group);
      const waiters = group;
      // A shared completion has one observer; aborted HTTP waiters leave no callbacks behind.
      void completion.then(
        (value) => {
          job.waitGroups.delete(completion);
          for (const waiter of waiters) waiter.resolve(value);
          waiters.clear();
        },
        (error) => {
          job.waitGroups.delete(completion);
          for (const waiter of waiters) waiter.reject(error);
          waiters.clear();
        },
      );
    }
    const waiters = group;
    job.interested++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const release = (): boolean => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", abort);
        waiters.delete(waiter);
        job.interested--;
        return true;
      };
      const abort = (): void => {
        if (!release()) return;
        this.cancellations++;
        if (job.interested === 0 && job.state === "queued") this.finish(job, { kind: "cancelled" });
        resolve(cancelled());
      };
      const waiter: CompletionWaiter = {
        // This group belongs to the Promise<T> supplied above; no foreign values enter it.
        resolve: (value) => {
          if (release()) resolve(value as T);
        },
        reject: (error) => {
          if (release()) reject(error);
        },
      };
      waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  getMetrics(): ProfileRefreshMetrics {
    return {
      active: this.active,
      waiting: this.queue.size,
      waitCount: this.waitCount,
      waitSumMs: this.waitSumMs,
      waitMaxMs: this.waitMaxMs,
      cancellations: this.cancellations,
    };
  }

  beginShutdown(): void {
    this.admitting = false;
    for (const job of this.queue) {
      this.cancellations++;
      this.finish(job, { kind: "cancelled" });
    }
  }

  async drain(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private schedule(): void {
    if (this.scheduled || !this.admitting) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    const ready: Job[] = [];
    const capacity = this.concurrency === 0 ? this.queue.size : this.concurrency - this.active;
    for (const job of this.queue) {
      if (ready.length >= capacity) break;
      this.queue.delete(job);
      job.state = "active";
      this.active++;
      const waitMs = performance.now() - job.queuedAtMs;
      this.waitCount++;
      this.waitSumMs += waitMs;
      this.waitMaxMs = Math.max(this.waitMaxMs, waitMs);
      ready.push(job);
    }
    if (ready.length > 0) void this.runBatch(ready);
  }

  private async runBatch(jobs: readonly Job[]): Promise<void> {
    let online: ReadonlySet<string>;
    try {
      online = await this.resolveOnline([...new Set(jobs.map((job) => job.agentId))]);
    } catch (error) {
      for (const job of jobs) this.finish(job, { kind: "presence_error", error });
      return;
    }
    await Promise.all(
      jobs.map(async (job) => {
        if (!online.has(job.agentId)) {
          this.finish(job, { kind: "offline" });
          return;
        }
        try {
          this.finish(job, { kind: "success", agent: await job.run!() });
        } catch (error) {
          this.finish(job, { kind: "refresh_error", error });
        }
      }),
    );
  }

  private finish(job: Job, outcome: RefreshOutcome): void {
    if (job.state === "settled") return;
    if (job.state === "active") this.active--;
    this.queue.delete(job);
    job.state = "settled";
    job.run = undefined;
    job.settle(outcome);
    this.schedule();
    if (this.active === 0) {
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    }
  }
}
