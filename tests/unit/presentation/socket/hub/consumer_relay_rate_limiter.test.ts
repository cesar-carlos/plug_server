import { beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../../../../src/shared/config/env";
import {
  allowRelayConversationStart,
  allowRelayRpcRequest,
  getRelayRateLimitMetricsSnapshot,
  resetRelayRateLimiterState,
} from "../../../../../src/presentation/socket/hub/consumer_relay_rate_limiter";

describe("consumer_relay_rate_limiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetRelayRateLimiterState();
  });

  it("should reject relay conversation starts above the configured limit", () => {
    const socketId = "consumer-1";
    for (let index = 0; index < env.socketRelayRateLimitMaxConversationStarts; index += 1) {
      expect(allowRelayConversationStart(socketId)).toBe(true);
    }

    expect(allowRelayConversationStart(socketId)).toBe(false);

    const snapshot = getRelayRateLimitMetricsSnapshot();
    expect(snapshot.counters.conversationStartAllowed).toBe(
      env.socketRelayRateLimitMaxConversationStarts,
    );
    expect(snapshot.counters.conversationStartRejected).toBe(1);
  });

  it("should reset counters after the configured rate-limit window", () => {
    vi.useFakeTimers();
    const socketId = "consumer-2";

    for (let index = 0; index < env.socketRelayRateLimitMaxRequests; index += 1) {
      expect(allowRelayRpcRequest(socketId)).toBe(true);
    }
    expect(allowRelayRpcRequest(socketId)).toBe(false);

    vi.advanceTimersByTime(env.socketRelayRateLimitWindowMs + 5);
    expect(allowRelayRpcRequest(socketId)).toBe(true);
  });
});

