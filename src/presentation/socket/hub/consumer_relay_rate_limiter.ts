import { env } from "../../../shared/config/env";

interface ConsumerRateLimitWindowState {
  windowStartMs: number;
  conversationStarts: number;
  relayRequests: number;
  streamPullCreditsGranted: number;
  lastSeenAtMs: number;
}

interface RelayRateLimitMetrics {
  conversationStartAllowedUser: number;
  conversationStartRejectedUser: number;
  conversationStartAllowedAnon: number;
  conversationStartRejectedAnon: number;
  relayRequestAllowedUser: number;
  relayRequestRejectedUser: number;
  relayRequestAllowedAnon: number;
  relayRequestRejectedAnon: number;
  streamPullCreditsGrantedUser: number;
  streamPullCreditsRejectedUser: number;
  streamPullCreditsGrantedAnon: number;
  streamPullCreditsRejectedAnon: number;
}

export interface RelayStreamPullAllowance {
  readonly allowed: boolean;
  readonly scope: "user" | "anon";
  readonly limit: number;
  readonly requestedCredits: number;
  readonly grantedCredits: number;
  readonly remainingCredits: number;
}

const statesByIdentityKey = new Map<string, ConsumerRateLimitWindowState>();
const relayRateLimitMetrics: RelayRateLimitMetrics = {
  conversationStartAllowedUser: 0,
  conversationStartRejectedUser: 0,
  conversationStartAllowedAnon: 0,
  conversationStartRejectedAnon: 0,
  relayRequestAllowedUser: 0,
  relayRequestRejectedUser: 0,
  relayRequestAllowedAnon: 0,
  relayRequestRejectedAnon: 0,
  streamPullCreditsGrantedUser: 0,
  streamPullCreditsRejectedUser: 0,
  streamPullCreditsGrantedAnon: 0,
  streamPullCreditsRejectedAnon: 0,
};

const buildIdentityKey = (userSub: string | undefined, socketId: string): { key: string; scope: "user" | "anon" } => {
  const trimmed = userSub?.trim();
  if (trimmed) {
    return { key: `relay:user:${trimmed}`, scope: "user" };
  }
  return { key: `relay:anon:${socketId}`, scope: "anon" };
};

const ensureWindowState = (identityKey: string): ConsumerRateLimitWindowState => {
  const nowMs = Date.now();
  const existing = statesByIdentityKey.get(identityKey);
  if (!existing) {
    const created: ConsumerRateLimitWindowState = {
      windowStartMs: nowMs,
      conversationStarts: 0,
      relayRequests: 0,
      streamPullCreditsGranted: 0,
      lastSeenAtMs: nowMs,
    };
    statesByIdentityKey.set(identityKey, created);
    return created;
  }

  if (nowMs - existing.windowStartMs >= env.socketRelayRateLimitWindowMs) {
    existing.windowStartMs = nowMs;
    existing.conversationStarts = 0;
    existing.relayRequests = 0;
    existing.streamPullCreditsGranted = 0;
  }
  existing.lastSeenAtMs = nowMs;
  return existing;
};

export const allowRelayConversationStart = (userSub: string | undefined, socketId: string): boolean => {
  const { key, scope } = buildIdentityKey(userSub, socketId);
  const state = ensureWindowState(key);
  if (state.conversationStarts >= env.socketRelayRateLimitMaxConversationStarts) {
    if (scope === "user") {
      relayRateLimitMetrics.conversationStartRejectedUser += 1;
    } else {
      relayRateLimitMetrics.conversationStartRejectedAnon += 1;
    }
    return false;
  }

  state.conversationStarts += 1;
  if (scope === "user") {
    relayRateLimitMetrics.conversationStartAllowedUser += 1;
  } else {
    relayRateLimitMetrics.conversationStartAllowedAnon += 1;
  }
  return true;
};

export const allowRelayRpcRequest = (userSub: string | undefined, socketId: string): boolean => {
  const { key, scope } = buildIdentityKey(userSub, socketId);
  const state = ensureWindowState(key);
  if (state.relayRequests >= env.socketRelayRateLimitMaxRequests) {
    if (scope === "user") {
      relayRateLimitMetrics.relayRequestRejectedUser += 1;
    } else {
      relayRateLimitMetrics.relayRequestRejectedAnon += 1;
    }
    return false;
  }

  state.relayRequests += 1;
  if (scope === "user") {
    relayRateLimitMetrics.relayRequestAllowedUser += 1;
  } else {
    relayRateLimitMetrics.relayRequestAllowedAnon += 1;
  }
  return true;
};

export const allowRelayStreamPull = (
  userSub: string | undefined,
  socketId: string,
  creditsRequested: number,
): RelayStreamPullAllowance => {
  const { key, scope } = buildIdentityKey(userSub, socketId);
  const state = ensureWindowState(key);
  const safeCreditsRequested = Math.max(0, Math.floor(creditsRequested));
  const limit = env.socketRelayRateLimitMaxStreamPullCredits;
  const remainingBefore = Math.max(0, limit - state.streamPullCreditsGranted);

  if (state.streamPullCreditsGranted + safeCreditsRequested > limit) {
    if (scope === "user") {
      relayRateLimitMetrics.streamPullCreditsRejectedUser += safeCreditsRequested;
    } else {
      relayRateLimitMetrics.streamPullCreditsRejectedAnon += safeCreditsRequested;
    }
    return {
      allowed: false,
      scope,
      limit,
      requestedCredits: safeCreditsRequested,
      grantedCredits: 0,
      remainingCredits: remainingBefore,
    };
  }

  state.streamPullCreditsGranted += safeCreditsRequested;
  if (scope === "user") {
    relayRateLimitMetrics.streamPullCreditsGrantedUser += safeCreditsRequested;
  } else {
    relayRateLimitMetrics.streamPullCreditsGrantedAnon += safeCreditsRequested;
  }
  return {
    allowed: true,
    scope,
    limit,
    requestedCredits: safeCreditsRequested,
    grantedCredits: safeCreditsRequested,
    remainingCredits: Math.max(0, limit - state.streamPullCreditsGranted),
  };
};

export const clearRelayRateLimitStateByConsumerSocket = (socketId: string): void => {
  const anonKey = `relay:anon:${socketId}`;
  statesByIdentityKey.delete(anonKey);
};

export const sweepRelayRateLimitState = (): void => {
  const nowMs = Date.now();
  const staleAfterMs = env.socketRelayRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;
  for (const [identityKey, state] of statesByIdentityKey.entries()) {
    if (nowMs - state.lastSeenAtMs >= staleAfterMs) {
      statesByIdentityKey.delete(identityKey);
    }
  }
};

export const getRelayRateLimitMetricsSnapshot = (): {
  readonly windowMs: number;
  readonly maxConversationStarts: number;
  readonly maxRequests: number;
  readonly activeIdentitiesTracked: number;
  readonly counters: RelayRateLimitMetrics;
} => ({
  windowMs: env.socketRelayRateLimitWindowMs,
  maxConversationStarts: env.socketRelayRateLimitMaxConversationStarts,
  maxRequests: env.socketRelayRateLimitMaxRequests,
  activeIdentitiesTracked: statesByIdentityKey.size,
  counters: {
    ...relayRateLimitMetrics,
  },
});

export const resetRelayRateLimiterState = (): void => {
  statesByIdentityKey.clear();
  relayRateLimitMetrics.conversationStartAllowedUser = 0;
  relayRateLimitMetrics.conversationStartRejectedUser = 0;
  relayRateLimitMetrics.conversationStartAllowedAnon = 0;
  relayRateLimitMetrics.conversationStartRejectedAnon = 0;
  relayRateLimitMetrics.relayRequestAllowedUser = 0;
  relayRateLimitMetrics.relayRequestRejectedUser = 0;
  relayRateLimitMetrics.relayRequestAllowedAnon = 0;
  relayRateLimitMetrics.relayRequestRejectedAnon = 0;
  relayRateLimitMetrics.streamPullCreditsGrantedUser = 0;
  relayRateLimitMetrics.streamPullCreditsRejectedUser = 0;
  relayRateLimitMetrics.streamPullCreditsGrantedAnon = 0;
  relayRateLimitMetrics.streamPullCreditsRejectedAnon = 0;
};

