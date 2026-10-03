import { IndexedExpirationHeap } from "./indexed_expiration_heap";

/** TTL-only eviction: valid entries are retained for the entire reuse window. */
export class IndexedTtlStore<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAtMs: number }>();
  private readonly expirations = new IndexedExpirationHeap<K>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private static readonly EXPIRATIONS_PER_TURN = 256;

  constructor(private readonly ttlMs: number) {}

  get(key: K, nowMs = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      this.expirations.delete(key);
      this.schedule();
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, nowMs = Date.now()): void {
    if (this.closed) return;
    const expiresAtMs = nowMs + this.ttlMs;
    this.entries.set(key, { value, expiresAtMs });
    this.expirations.set(key, expiresAtMs);
    this.schedule();
  }

  getCardinality(): { entries: number; expirations: number; timers: number } {
    return {
      entries: this.entries.size,
      expirations: this.expirations.size,
      timers: this.timer === undefined ? 0 : 1,
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
    this.expirations.clear();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.expirations.peek();
    if (next === undefined || this.closed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const nowMs = Date.now();
        for (let count = 0; count < IndexedTtlStore.EXPIRATIONS_PER_TURN; count++) {
          const key = this.expirations.takeExpired(nowMs);
          if (key === undefined) break;
          this.entries.delete(key);
        }
        this.schedule();
      },
      Math.min(2_147_483_647, Math.max(0, next.expiresAtMs - Date.now())),
    );
    this.timer.unref();
  }
}
