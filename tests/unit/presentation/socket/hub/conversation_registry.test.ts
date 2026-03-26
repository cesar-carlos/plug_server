import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationRegistry } from "../../../../../src/presentation/socket/hub/conversation_registry";

afterEach(() => {
  conversationRegistry.clear();
  vi.useRealTimers();
});

describe("conversation_registry", () => {
  it("removeExpired collects ids first then removes (no in-map mutation while scanning)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

    conversationRegistry.create({
      consumerSocketId: "cons",
      agentSocketId: "agentSock",
      agentId: "agent1",
      conversationId: "conv-a",
    });
    conversationRegistry.create({
      consumerSocketId: "cons",
      agentSocketId: "agentSock",
      agentId: "agent1",
      conversationId: "conv-b",
    });

    vi.setSystemTime(new Date("2026-01-01T12:00:02.000Z"));
    conversationRegistry.touch("conv-a");

    // b last seen t0; a last seen t0+2s. At exactly t0+1h, b age >= 1h and a age < 1h.
    vi.setSystemTime(new Date("2026-01-01T13:00:00.000Z"));
    const removed = conversationRegistry.removeExpired(60 * 60 * 1000);

    expect(removed.map((c) => c.conversationId).sort()).toEqual(["conv-b"]);
    expect(conversationRegistry.findByConversationId("conv-a")).not.toBeNull();
    expect(conversationRegistry.findByConversationId("conv-b")).toBeNull();
  });

  it("exposes internal fast-path view and updates timestamps via touchInternal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    conversationRegistry.create({
      consumerSocketId: "c1",
      agentSocketId: "a1",
      agentId: "ag",
      conversationId: "internal-fast-path",
    });

    const before = conversationRegistry.findInternalByConversationId("internal-fast-path");
    expect(before).not.toBeNull();
    expect(before?.createdAtMs).toBeTypeOf("number");
    expect(before?.lastSeenAtMs).toBeTypeOf("number");

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const after = conversationRegistry.touchInternal("internal-fast-path");
    expect(after).not.toBeNull();
    expect(after?.lastSeenAtMs).toBeGreaterThan(before?.lastSeenAtMs ?? 0);
  });
});
