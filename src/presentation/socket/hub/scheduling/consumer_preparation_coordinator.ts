import { performance } from "node:perf_hooks";

export type PreparationResult<T> =
  { readonly cancelled: true } | { readonly cancelled: false; readonly value: T };

export interface ConsumerPreparationMetrics {
  readonly active: number;
  readonly waiting: number;
  readonly waitingBytes: number;
  readonly waitCount: number;
  readonly waitSumMs: number;
  readonly waitMaxMs: number;
}

interface QueuedPreparation {
  readonly bytes: number;
  readonly queuedAt: number;
  readonly start: (finish: () => void, isCancelled: () => boolean) => void;
  readonly cancel: () => void;
}

interface SocketPreparations {
  readonly queue: QueuedPreparation[];
  head: number;
  active: number;
  cancelled: boolean;
}

/** Count actual wire storage without parsing/stringifying untrusted bodies on the admission path. */
const receivedFrameBytes = (payload: unknown): number => {
  if (typeof payload !== "object" || payload === null) return 0;
  const value = (payload as { payload?: unknown }).payload;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  return Array.isArray(value) ? value.length : 0;
};

/** Per-hub preparation lanes; queueing preserves validation/error precedence under saturation. */
export class ConsumerPreparationCoordinator {
  private readonly sockets = new Map<string, SocketPreparations>();
  private readonly ready = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private closed = false;
  private active = 0;
  private waiting = 0;
  private waitingBytes = 0;
  private waitCount = 0;
  private waitSumMs = 0;
  private waitMaxMs = 0;

  constructor(private readonly limits: { readonly perSocket: number; readonly perHub: number }) {}

  public run<T>(
    socketId: string,
    payload: unknown,
    work: () => T | Promise<T>,
  ): Promise<PreparationResult<T>> {
    if (this.closed) return Promise.resolve({ cancelled: true });
    const state = this.sockets.get(socketId) ?? { queue: [], head: 0, active: 0, cancelled: false };
    this.sockets.set(socketId, state);
    const bytes = receivedFrameBytes(payload);
    return new Promise<PreparationResult<T>>((resolve, reject) => {
      state.queue.push({
        bytes,
        queuedAt: performance.now(),
        cancel: () => resolve({ cancelled: true }),
        start: (finish, isCancelled) => {
          void Promise.resolve()
            .then(work)
            .then(
              (value) => {
                const cancelled = isCancelled();
                finish();
                resolve(cancelled ? { cancelled: true } : { cancelled: false, value });
              },
              (error: unknown) => {
                const cancelled = isCancelled();
                finish();
                if (cancelled) resolve({ cancelled: true });
                else reject(error);
              },
            );
        },
      });
      this.waiting += 1;
      this.waitingBytes += bytes;
      this.markReady(socketId, state);
      this.pump();
    });
  }

  private markReady(socketId: string, state: SocketPreparations): void {
    if (
      !state.cancelled &&
      state.head < state.queue.length &&
      (this.limits.perSocket <= 0 || state.active < this.limits.perSocket)
    )
      this.ready.add(socketId);
  }

  private pump(): void {
    while (
      !this.closed &&
      this.ready.size > 0 &&
      (this.limits.perHub <= 0 || this.active < this.limits.perHub)
    ) {
      const socketId = this.ready.values().next().value as string;
      this.ready.delete(socketId);
      const state = this.sockets.get(socketId)!;
      const job = state.queue[state.head++]!;
      // Remove consumed closures immediately, rather than retaining decoded payloads until a lane empties.
      if (state.head === state.queue.length) {
        state.queue.length = 0;
        state.head = 0;
      } else {
        delete state.queue[state.head - 1];
        if (state.head >= 1_024 && state.head * 2 >= state.queue.length) {
          state.queue.splice(0, state.head);
          state.head = 0;
        }
      }
      this.waiting -= 1;
      this.waitingBytes -= job.bytes;
      const wait = Math.max(0, performance.now() - job.queuedAt);
      this.waitCount += 1;
      this.waitSumMs += wait;
      this.waitMaxMs = Math.max(this.waitMaxMs, wait);
      this.active += 1;
      state.active += 1;
      this.markReady(socketId, state);
      job.start(
        () => {
          this.active -= 1;
          state.active -= 1;
          if (this.sockets.get(socketId) === state) {
            if (state.active === 0 && state.head === state.queue.length)
              this.sockets.delete(socketId);
            else this.markReady(socketId, state);
          }
          this.pump();
          if (this.active === 0) {
            for (const resolve of this.idleWaiters) resolve();
            this.idleWaiters.clear();
          }
        },
        () => state.cancelled || this.closed,
      );
    }
  }

  public cancelSocket(socketId: string): void {
    const state = this.sockets.get(socketId);
    if (!state) return;
    state.cancelled = true;
    this.ready.delete(socketId);
    this.sockets.delete(socketId);
    for (let index = state.head; index < state.queue.length; index += 1) {
      const job = state.queue[index]!;
      this.waiting -= 1;
      this.waitingBytes -= job.bytes;
      job.cancel();
    }
    state.queue.length = 0;
    state.head = 0;
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const socketId of this.sockets.keys()) this.cancelSocket(socketId);
    if (this.active > 0) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  public getMetrics(): ConsumerPreparationMetrics {
    return {
      active: this.active,
      waiting: this.waiting,
      waitingBytes: this.waitingBytes,
      waitCount: this.waitCount,
      waitSumMs: this.waitSumMs,
      waitMaxMs: this.waitMaxMs,
    };
  }
}
