import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  clearRelayIdempotencyForConversation,
  getOrCreateRelayIdempotencyMap,
  getRelayIdempotencyMap,
  getRelayIdempotencyMetricsSnapshot,
  pruneExpiredRelayIdempotencyEntries,
  pruneRelayIdempotencyWaiterSocket,
  removeRelayIdempotencyEntry,
  resetRelayIdempotencyStore,
  setRelayIdempotencyEntry,
} from "../../../../../src/presentation/socket/hub/registries/relay_idempotency_store";
import {
  registerRelayRequestRoute,
  resetRelayRequestRegistry,
} from "../../../../../src/presentation/socket/hub/registries/relay_request_registry";

afterEach(() => {
  resetRelayIdempotencyStore();
  resetRelayRequestRegistry();
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
    map.set("client1", {
      requestId: "r1",
      expiresAtMs: Date.now() + 1000,
      responseFrame: { ok: true },
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    pruneExpiredRelayIdempotencyEntries();

    expect(getRelayIdempotencyMap("c1")).toBeUndefined();
  });

  it("prunes only expired client ids and keeps the conversation map when others remain", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const map = getOrCreateRelayIdempotencyMap("c1");
    map.set("old", { requestId: "r0", expiresAtMs: Date.now() + 500, responseFrame: { ok: true } });
    map.set("fresh", {
      requestId: "r1",
      expiresAtMs: Date.now() + 60_000,
      responseFrame: { ok: true },
    });

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

  it("removeRelayIdempotencyEntry removes one client id and drops empty buckets", () => {
    getOrCreateRelayIdempotencyMap("c1").set("x", {
      requestId: "r",
      expiresAtMs: Date.now() + 60_000,
    });

    removeRelayIdempotencyEntry("c1", "x");

    expect(getRelayIdempotencyMap("c1")).toBeUndefined();
  });

  it("prunes expired in-flight entries when the relay route no longer exists", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    setRelayIdempotencyEntry("c1", "in-flight", {
      requestId: "r1",
      expiresAtMs: Date.now() + 100,
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    pruneExpiredRelayIdempotencyEntries();

    expect(getRelayIdempotencyMap("c1")).toBeUndefined();
  });

  it("does not prune an expired in-flight entry while the relay route is still registered", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    registerRelayRequestRoute({
      requestId: "r1",
      conversationId: "c1",
      consumerSocketId: "consumer-1",
      agentSocketId: "agent-socket-1",
      agentId: "agent-1",
      timeoutHandle: {} as NodeJS.Timeout,
      createdAtMs: Date.now(),
    });

    setRelayIdempotencyEntry("c1", "in-flight", {
      requestId: "r1",
      expiresAtMs: Date.now() + 100,
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    pruneExpiredRelayIdempotencyEntries();

    expect(getRelayIdempotencyMap("c1")?.get("in-flight")?.requestId).toBe("r1");
  });

  it("does not evict in-flight entries to satisfy the per-conversation cap", () => {
    const ttl = Date.now() + 60_000;
    const limit = env.socketRelayIdempotencyMaxEntriesPerConversation;
    for (let index = 0; index < limit; index += 1) {
      setRelayIdempotencyEntry("c1", `pending-${index}`, {
        requestId: `req-${index}`,
        expiresAtMs: ttl,
      });
    }

    const result = setRelayIdempotencyEntry("c1", "pending-overflow", {
      requestId: "req-overflow",
      expiresAtMs: ttl,
    });

    expect(result).toEqual({ ok: false, reason: "per_conversation_cap_reached" });
    const map = getRelayIdempotencyMap("c1");
    expect(map?.size).toBe(limit);
    expect(map?.has("pending-0")).toBe(true);
    expect(map?.has("pending-overflow")).toBe(false);
    expect(getRelayIdempotencyMetricsSnapshot().evictedPerConversationCap).toBe(0);
  });

  it("pruneRelayIdempotencyWaiterSocket removes a consumer from waiter sets", () => {
    const map = getOrCreateRelayIdempotencyMap("c1");
    map.set("client1", {
      requestId: "r1",
      expiresAtMs: Date.now() + 60_000,
      pendingReplayConsumerSocketIds: new Set(["sock-a", "sock-b"]),
    });

    expect(pruneRelayIdempotencyWaiterSocket("sock-a")).toBe(1);
    expect(map.get("client1")?.pendingReplayConsumerSocketIds).toEqual(new Set(["sock-b"]));
    expect(pruneRelayIdempotencyWaiterSocket("sock-b")).toBe(1);
    expect(map.get("client1")?.pendingReplayConsumerSocketIds).toBeUndefined();
  });
});
