import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedExpirationHeap } from "../../../../src/shared/utils/indexed_expiration_heap";
import { IndexedTtlStore } from "../../../../src/shared/utils/indexed_ttl_store";

afterEach(() => vi.useRealTimers());

describe("indexed expiration", () => {
  it("orders updates and removals without retaining old nodes", () => {
    const heap = new IndexedExpirationHeap<string>();
    for (let i = 0; i < 1000; i++) heap.set(String(i), 1000 - i);
    for (let i = 0; i < 1000; i++) heap.set(String(i), i);
    heap.delete("0");
    heap.delete("999");
    expect(heap.size).toBe(998);
    for (let i = 1; i < 999; i++) expect(heap.takeExpired(1000)).toBe(String(i));
    expect(heap.size).toBe(0);
  });

  it("rejects expired reads even before a delayed timer and preserves renewed TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new IndexedTtlStore<string, number>(30_000);
    cache.set("a", 1);
    cache.set("b", 2);
    vi.setSystemTime(20_000);
    cache.set("a", 3);
    vi.setSystemTime(30_000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(3);
    expect(cache.getCardinality()).toEqual({ entries: 1, expirations: 1, timers: 1 });
    vi.setSystemTime(50_000);
    expect(cache.get("a")).toBeUndefined();
    cache.close();
  });

  it("drains twenty thousand expirations in bounded turns and never repopulates after close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new IndexedTtlStore<number, number>(30_000);
    for (let i = 0; i < 20_000; i++) cache.set(i, i);
    expect(cache.getCardinality()).toEqual({ entries: 20_000, expirations: 20_000, timers: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cache.getCardinality().entries).toBe(20_000 - 256);
    await vi.runAllTimersAsync();
    expect(cache.getCardinality()).toEqual({ entries: 0, expirations: 0, timers: 0 });
    cache.close();
    cache.set(1, 1);
    expect(cache.getCardinality().entries).toBe(0);
  });
});
