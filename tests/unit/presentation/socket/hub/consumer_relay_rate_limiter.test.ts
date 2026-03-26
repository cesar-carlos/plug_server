import { beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  allowRelayConversationStart,
  allowRelayRpcRequest,
  allowRelayStreamPull,
  clearRelayRateLimitStateByConsumerSocket,
  getRelayRateLimitMetricsSnapshot,
  resetRelayRateLimiterState,
  sweepRelayRateLimitState,
} from "../../../../../src/presentation/socket/hub/consumer_relay_rate_limiter";

describe("consumer_relay_rate_limiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetRelayRateLimiterState();
  });

  it("should reject relay conversation starts above the configured limit for authenticated user", () => {
    const userSub = "user123";
    const socketId = "consumer-1";
    for (let index = 0; index < env.socketRelayRateLimitMaxConversationStarts; index += 1) {
      expect(allowRelayConversationStart(userSub, socketId)).toBe(true);
    }

    expect(allowRelayConversationStart(userSub, socketId)).toBe(false);

    const snapshot = getRelayRateLimitMetricsSnapshot();
    expect(snapshot.counters.conversationStartAllowedUser).toBe(
      env.socketRelayRateLimitMaxConversationStarts,
    );
    expect(snapshot.counters.conversationStartRejectedUser).toBe(1);
  });

  it("should reject relay conversation starts above the configured limit for anonymous socket", () => {
    const socketId = "consumer-anon";
    for (let index = 0; index < env.socketRelayRateLimitMaxConversationStarts; index += 1) {
      expect(allowRelayConversationStart(undefined, socketId)).toBe(true);
    }

    expect(allowRelayConversationStart(undefined, socketId)).toBe(false);

    const snapshot = getRelayRateLimitMetricsSnapshot();
    expect(snapshot.counters.conversationStartAllowedAnon).toBe(
      env.socketRelayRateLimitMaxConversationStarts,
    );
    expect(snapshot.counters.conversationStartRejectedAnon).toBe(1);
  });

  it("should reset counters after the configured rate-limit window", () => {
    vi.useFakeTimers();
    const userSub = "user456";
    const socketId = "consumer-2";

    for (let index = 0; index < env.socketRelayRateLimitMaxRequests; index += 1) {
      expect(allowRelayRpcRequest(userSub, socketId)).toBe(true);
    }
    expect(allowRelayRpcRequest(userSub, socketId)).toBe(false);

    vi.advanceTimersByTime(env.socketRelayRateLimitWindowMs + 5);
    expect(allowRelayRpcRequest(userSub, socketId)).toBe(true);
  });

  it("same user sub shares rate limit across reconnections", () => {
    const userSub = "user789";
    const maxStarts = env.socketRelayRateLimitMaxConversationStarts;
    for (let i = 0; i < maxStarts; i++) {
      expect(allowRelayConversationStart(userSub, `sock-${i}`)).toBe(true);
    }
    expect(allowRelayConversationStart(userSub, "sock-new")).toBe(false);
  });

  it("clearRelayRateLimitStateByConsumerSocket removes only anonymous state for given socket", () => {
    const userSub = "userABC";
    allowRelayConversationStart(userSub, "sock5");
    allowRelayConversationStart(undefined, "sock5");
    const snapshotBefore = getRelayRateLimitMetricsSnapshot();
    expect(snapshotBefore.activeIdentitiesTracked).toBe(2);

    clearRelayRateLimitStateByConsumerSocket("sock5");

    const snapshotAfter = getRelayRateLimitMetricsSnapshot();
    expect(snapshotAfter.activeIdentitiesTracked).toBe(1);
  });

  it("sweepRelayRateLimitState removes stale windows", () => {
    allowRelayConversationStart("userDEF", "sock6");
    expect(getRelayRateLimitMetricsSnapshot().activeIdentitiesTracked).toBeGreaterThan(0);
    const stub = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + env.socketRelayRateLimitWindowMs * 10);
    sweepRelayRateLimitState();
    stub.mockRestore();
    expect(getRelayRateLimitMetricsSnapshot().activeIdentitiesTracked).toBe(0);
  });

  it("allowRelayStreamPull returns remaining credits for accepted and rejected pulls", () => {
    const accepted = allowRelayStreamPull("user-pull", "sock7", 400);
    expect(accepted.allowed).toBe(true);
    expect(accepted.limit).toBe(env.socketRelayRateLimitMaxStreamPullCredits);
    expect(accepted.remainingCredits).toBe(env.socketRelayRateLimitMaxStreamPullCredits - 400);

    const rejected = allowRelayStreamPull(
      "user-pull",
      "sock7",
      env.socketRelayRateLimitMaxStreamPullCredits,
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.remainingCredits).toBe(env.socketRelayRateLimitMaxStreamPullCredits - 400);
    expect(rejected.scope).toBe("user");
  });
});
