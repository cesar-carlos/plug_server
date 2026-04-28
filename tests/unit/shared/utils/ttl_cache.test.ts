import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { TtlCache } from "../../../../src/shared/utils/ttl_cache";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a missing key", () => {
    const cache = new TtlCache<string, number>(1_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns the stored value before TTL expires", () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set("k", 42);
    vi.advanceTimersByTime(999);
    expect(cache.get("k")).toBe(42);
  });

  it("returns undefined and removes entry after TTL expires", () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set("k", 42);
    vi.advanceTimersByTime(1_001);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("overwrites existing entry and resets TTL", () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set("k", 1);
    vi.advanceTimersByTime(500);
    cache.set("k", 2);
    vi.advanceTimersByTime(800);
    expect(cache.get("k")).toBe(2);
    vi.advanceTimersByTime(300);
    expect(cache.get("k")).toBeUndefined();
  });

  it("delete removes an entry immediately", () => {
    const cache = new TtlCache<string, number>(10_000);
    cache.set("k", 1);
    cache.delete("k");
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("deleteWhere removes matching entries only", () => {
    const cache = new TtlCache<string, string>(10_000);
    cache.set("a:1", "va");
    cache.set("b:2", "vb");
    cache.set("a:3", "vc");
    cache.deleteWhere((k) => k.startsWith("a:"));
    expect(cache.get("a:1")).toBeUndefined();
    expect(cache.get("a:3")).toBeUndefined();
    expect(cache.get("b:2")).toBe("vb");
    expect(cache.size).toBe(1);
  });

  it("clear empties the cache", () => {
    const cache = new TtlCache<string, number>(10_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  describe("maxSize eviction", () => {
    it("evicts the oldest stale entry when at capacity", () => {
      const cache = new TtlCache<string, number>(1_000, 2);
      cache.set("a", 1);
      vi.advanceTimersByTime(1_100); // make "a" stale
      cache.set("b", 2);
      // Now at capacity 1/2 with stale "a"; adding "c" should evict stale "a"
      cache.set("c", 3);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
    });

    it("evicts the oldest fresh entry when capacity is full and no stale entries", () => {
      const cache = new TtlCache<string, number>(10_000, 2);
      cache.set("a", 1);
      cache.set("b", 2);
      // Cache is full, both fresh — adding "c" must evict "a" (oldest insertion)
      cache.set("c", 3);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
      expect(cache.size).toBeLessThanOrEqual(2);
    });

    it("updating an existing key does not trigger eviction", () => {
      const cache = new TtlCache<string, number>(10_000, 2);
      cache.set("a", 1);
      cache.set("b", 2);
      // Update existing — should not evict anything
      cache.set("a", 99);
      expect(cache.get("a")).toBe(99);
      expect(cache.get("b")).toBe(2);
      expect(cache.size).toBe(2);
    });
  });

  it("size reflects the live entry count", () => {
    const cache = new TtlCache<string, number>(1_000);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
    cache.delete("a");
    expect(cache.size).toBe(1);
    vi.advanceTimersByTime(1_001);
    cache.get("b"); // triggers lazy eviction
    expect(cache.size).toBe(0);
  });
});
