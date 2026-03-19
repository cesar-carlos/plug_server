import { env } from "../../../shared/config/env";

interface ConsumerRateLimitWindowState {
  windowStartMs: number;
  conversationStarts: number;
  relayRequests: number;
  lastSeenAtMs: number;
}

interface RelayRateLimitMetrics {
  conversationStartAllowed: number;
  conversationStartRejected: number;
  relayRequestAllowed: number;
  relayRequestRejected: number;
}

const statesByConsumerSocketId = new Map<string, ConsumerRateLimitWindowState>();
const relayRateLimitMetrics: RelayRateLimitMetrics = {
  conversationStartAllowed: 0,
  conversationStartRejected: 0,
  relayRequestAllowed: 0,
  relayRequestRejected: 0,
};

const ensureWindowState = (consumerSocketId: string): ConsumerRateLimitWindowState => {
  const nowMs = Date.now();
  const existing = statesByConsumerSocketId.get(consumerSocketId);
  if (!existing) {
    const created: ConsumerRateLimitWindowState = {
      windowStartMs: nowMs,
      conversationStarts: 0,
      relayRequests: 0,
      lastSeenAtMs: nowMs,
    };
    statesByConsumerSocketId.set(consumerSocketId, created);
    return created;
  }

  if (nowMs - existing.windowStartMs >= env.socketRelayRateLimitWindowMs) {
    existing.windowStartMs = nowMs;
    existing.conversationStarts = 0;
    existing.relayRequests = 0;
  }
  existing.lastSeenAtMs = nowMs;
  return existing;
};

export const allowRelayConversationStart = (consumerSocketId: string): boolean => {
  const state = ensureWindowState(consumerSocketId);
  if (state.conversationStarts >= env.socketRelayRateLimitMaxConversationStarts) {
    relayRateLimitMetrics.conversationStartRejected += 1;
    return false;
  }

  state.conversationStarts += 1;
  relayRateLimitMetrics.conversationStartAllowed += 1;
  return true;
};

export const allowRelayRpcRequest = (consumerSocketId: string): boolean => {
  const state = ensureWindowState(consumerSocketId);
  if (state.relayRequests >= env.socketRelayRateLimitMaxRequests) {
    relayRateLimitMetrics.relayRequestRejected += 1;
    return false;
  }

  state.relayRequests += 1;
  relayRateLimitMetrics.relayRequestAllowed += 1;
  return true;
};

export const clearRelayRateLimitStateByConsumerSocket = (consumerSocketId: string): void => {
  statesByConsumerSocketId.delete(consumerSocketId);
};

export const sweepRelayRateLimitState = (): void => {
  const nowMs = Date.now();
  const staleAfterMs = env.socketRelayRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;
  for (const [consumerSocketId, state] of statesByConsumerSocketId.entries()) {
    if (nowMs - state.lastSeenAtMs >= staleAfterMs) {
      statesByConsumerSocketId.delete(consumerSocketId);
    }
  }
};

export const getRelayRateLimitMetricsSnapshot = (): {
  readonly windowMs: number;
  readonly maxConversationStarts: number;
  readonly maxRequests: number;
  readonly activeConsumersTracked: number;
  readonly counters: RelayRateLimitMetrics;
} => ({
  windowMs: env.socketRelayRateLimitWindowMs,
  maxConversationStarts: env.socketRelayRateLimitMaxConversationStarts,
  maxRequests: env.socketRelayRateLimitMaxRequests,
  activeConsumersTracked: statesByConsumerSocketId.size,
  counters: {
    ...relayRateLimitMetrics,
  },
});

export const resetRelayRateLimiterState = (): void => {
  statesByConsumerSocketId.clear();
  relayRateLimitMetrics.conversationStartAllowed = 0;
  relayRateLimitMetrics.conversationStartRejected = 0;
  relayRateLimitMetrics.relayRequestAllowed = 0;
  relayRateLimitMetrics.relayRequestRejected = 0;
};

