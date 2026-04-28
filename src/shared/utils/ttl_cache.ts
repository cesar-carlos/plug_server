/**
 * Simple in-memory TTL cache backed by a Map.
 *
 * - Entries expire after `ttlMs` milliseconds.
 * - When `maxSize > 0`, the oldest entry is evicted before inserting a new one
 *   once the map reaches capacity (after first removing any stale entries).
 * - All operations are synchronous and O(1) amortised (stale eviction during
 *   `set` is O(n) worst-case but bounded by `maxSize`).
 * - Designed for single-process use — not distributed-safe.
 */

interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAtMs: number;
}

export class TtlCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number = 0,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAtMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.maxSize > 0 && !this.map.has(key) && this.map.size >= this.maxSize) {
      this.evictStale();
      if (this.map.size >= this.maxSize) {
        const firstKey = this.map.keys().next().value;
        if (firstKey !== undefined) {
          this.map.delete(firstKey);
        }
      }
    }
    this.map.set(key, { value, expiresAtMs: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /** Delete all entries whose key satisfies `predicate`. O(n). */
  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of this.map.keys()) {
      if (predicate(key)) {
        this.map.delete(key);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  private evictStale(): void {
    const nowMs = Date.now();
    for (const [key, entry] of this.map) {
      if (nowMs > entry.expiresAtMs) {
        this.map.delete(key);
      }
    }
  }
}
