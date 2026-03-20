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

  it("removeExpired skips conversations with unparseable lastSeenAt", () => {
    conversationRegistry.create({
      consumerSocketId: "c1",
      agentSocketId: "a1",
      agentId: "ag",
      conversationId: "bad-date",
    });
    const reg = conversationRegistry as unknown as {
      conversations: Map<string, { lastSeenAt: string }>;
    };
    const row = reg.conversations.get("bad-date");
    expect(row).toBeDefined();
    if (row) row.lastSeenAt = "not-a-date";

    const removed = conversationRegistry.removeExpired(1);
    expect(removed).toHaveLength(0);
    expect(conversationRegistry.findByConversationId("bad-date")).not.toBeNull();
  });
});
