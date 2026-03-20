import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRelayIdempotencyForConversation,
  getOrCreateRelayIdempotencyMap,
  getRelayIdempotencyMap,
  pruneExpiredRelayIdempotencyEntries,
  resetRelayIdempotencyStore,
} from "../../../../../src/presentation/socket/hub/relay_idempotency_store";

afterEach(() => {
  resetRelayIdempotencyStore();
  vi.useRealTimers();
});

describe("relay_idempotency_store", () => {
  it("returns the same map from getOrCreate for a conversation", () => {
    const a = getOrCreateRelayIdempotencyMap("c1");
    const b = getOrCreateRelayIdempotencyMap("c1");
    expect(a).toBe(b);
  });

  it("prunes expired entries and drops empty conversation maps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const map = getOrCreateRelayIdempotencyMap("c1");
    map.set("client1", { requestId: "r1", expiresAtMs: Date.now() + 1000 });

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    pruneExpiredRelayIdempotencyEntries();

    expect(getRelayIdempotencyMap("c1")).toBeUndefined();
  });

  it("prunes only expired client ids and keeps the conversation map when others remain", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const map = getOrCreateRelayIdempotencyMap("c1");
    map.set("old", { requestId: "r0", expiresAtMs: Date.now() + 500 });
    map.set("fresh", { requestId: "r1", expiresAtMs: Date.now() + 60_000 });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    pruneExpiredRelayIdempotencyEntries();

    const after = getRelayIdempotencyMap("c1");
    expect(after).toBeDefined();
    expect(after?.has("old")).toBe(false);
    expect(after?.get("fresh")?.requestId).toBe("r1");
  });

  it("clearRelayIdempotencyForConversation removes the conversation bucket", () => {
    getOrCreateRelayIdempotencyMap("c1").set("x", {
      requestId: "r",
      expiresAtMs: Date.now() + 60_000,
    });
    clearRelayIdempotencyForConversation("c1");
    expect(getRelayIdempotencyMap("c1")).toBeUndefined();
  });
});
