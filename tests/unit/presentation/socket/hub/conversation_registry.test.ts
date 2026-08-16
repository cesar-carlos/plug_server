import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import { env } from "../../../../../src/shared/config/env";

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

  it("reusing a conversation id clears stale consumer and agent indexes", () => {
    conversationRegistry.create({
      consumerSocketId: "consumer-old",
      agentSocketId: "agent-socket-old",
      agentId: "agent-old",
      conversationId: "conv-reused",
    });
    conversationRegistry.create({
      consumerSocketId: "consumer-new",
      agentSocketId: "agent-socket-new",
      agentId: "agent-new",
      conversationId: "conv-reused",
    });

    expect(conversationRegistry.countByConsumerSocketId("consumer-old")).toBe(0);
    expect(conversationRegistry.countByConsumerSocketId("consumer-new")).toBe(1);
    expect(conversationRegistry.removeByAgentSocketId("agent-socket-old")).toEqual([]);
    expect(conversationRegistry.removeByAgentSocketId("agent-socket-new")).toHaveLength(1);
  });

  it("debounces touchInternalDebounced within the configured window", () => {
    const originalDebounceMs = env.socketRelayConversationTouchDebounceMs;
    env.socketRelayConversationTouchDebounceMs = 5_000;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    conversationRegistry.create({
      consumerSocketId: "c1",
      agentSocketId: "a1",
      agentId: "ag",
      conversationId: "conv-debounce",
    });

    conversationRegistry.touchInternalDebounced("conv-debounce");
    expect(conversationRegistry.findInternalByConversationId("conv-debounce")?.lastSeenAtMs).toBe(
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    conversationRegistry.touchInternalDebounced("conv-debounce");
    expect(conversationRegistry.findInternalByConversationId("conv-debounce")?.lastSeenAtMs).toBe(
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    vi.setSystemTime(new Date("2026-01-01T00:00:06.000Z"));
    conversationRegistry.touchInternalDebounced("conv-debounce");
    expect(conversationRegistry.findInternalByConversationId("conv-debounce")?.lastSeenAtMs).toBe(
      Date.parse("2026-01-01T00:00:06.000Z"),
    );

    env.socketRelayConversationTouchDebounceMs = originalDebounceMs;
  });

  it("touchInternalDebounced with debounce 0 preserves every-touch behavior", () => {
    const originalDebounceMs = env.socketRelayConversationTouchDebounceMs;
    env.socketRelayConversationTouchDebounceMs = 0;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    conversationRegistry.create({
      consumerSocketId: "c1",
      agentSocketId: "a1",
      agentId: "ag",
      conversationId: "conv-every-touch",
    });

    conversationRegistry.touchInternalDebounced("conv-every-touch");
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    conversationRegistry.touchInternalDebounced("conv-every-touch");
    expect(conversationRegistry.findInternalByConversationId("conv-every-touch")?.lastSeenAtMs).toBe(
      Date.parse("2026-01-01T00:00:01.000Z"),
    );

    env.socketRelayConversationTouchDebounceMs = originalDebounceMs;
  });
});
