import { env } from "../../../../shared/config/env";
import {
  consumeSocketRateLimitRedis,
  refundSocketRateLimitRedis,
} from "../../../../infrastructure/redis/rate_limit/socket_rate_limit_redis";
import { consumeSocketRateLimitLocalFirstAsync } from "./socket_rate_limit_redis_local_first";

interface ConsumerRateLimitWindowState {
  windowStartMs: number;
  conversationStarts: number;
  relayRequests: number;
  streamPullCreditsGranted: number;
  agentsStreamPullCreditsGranted: number;
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
  agentsStreamPullCreditsGrantedUser: number;
  agentsStreamPullCreditsRejectedUser: number;
  agentsStreamPullCreditsGrantedAnon: number;
  agentsStreamPullCreditsRejectedAnon: number;
}

export interface RelayStreamPullAllowance {
  readonly allowed: boolean;
  readonly scope: "user" | "anon";
  readonly limit: number;
  readonly requestedCredits: number;
  readonly grantedCredits: number;
  readonly remainingCredits: number;
}

export type AgentsStreamPullAllowance = RelayStreamPullAllowance;

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
  agentsStreamPullCreditsGrantedUser: 0,
  agentsStreamPullCreditsRejectedUser: 0,
  agentsStreamPullCreditsGrantedAnon: 0,
  agentsStreamPullCreditsRejectedAnon: 0,
};

const buildIdentityKey = (
  userSub: string | undefined,
  socketId: string,
): { key: string; scope: "user" | "anon" } => {
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
      agentsStreamPullCreditsGranted: 0,
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
    existing.agentsStreamPullCreditsGranted = 0;
  }
  existing.lastSeenAtMs = nowMs;
  return existing;
};

const noteConversationStartDecision = (scope: "user" | "anon", allowed: boolean): void => {
  if (scope === "user") {
    if (allowed) {
      relayRateLimitMetrics.conversationStartAllowedUser += 1;
    } else {
      relayRateLimitMetrics.conversationStartRejectedUser += 1;
    }
    return;
  }
  if (allowed) {
    relayRateLimitMetrics.conversationStartAllowedAnon += 1;
  } else {
    relayRateLimitMetrics.conversationStartRejectedAnon += 1;
  }
};

const noteRelayRequestDecision = (scope: "user" | "anon", allowed: boolean): void => {
  if (scope === "user") {
    if (allowed) {
      relayRateLimitMetrics.relayRequestAllowedUser += 1;
    } else {
      relayRateLimitMetrics.relayRequestRejectedUser += 1;
    }
    return;
  }
  if (allowed) {
    relayRateLimitMetrics.relayRequestAllowedAnon += 1;
  } else {
    relayRateLimitMetrics.relayRequestRejectedAnon += 1;
  }
};

const noteRelayStreamPullCredits = (
  scope: "user" | "anon",
  allowed: boolean,
  credits: number,
): void => {
  if (scope === "user") {
    if (allowed) {
      relayRateLimitMetrics.streamPullCreditsGrantedUser += credits;
    } else {
      relayRateLimitMetrics.streamPullCreditsRejectedUser += credits;
    }
    return;
  }
  if (allowed) {
    relayRateLimitMetrics.streamPullCreditsGrantedAnon += credits;
  } else {
    relayRateLimitMetrics.streamPullCreditsRejectedAnon += credits;
  }
};

const noteAgentsStreamPullCredits = (
  scope: "user" | "anon",
  allowed: boolean,
  credits: number,
): void => {
  if (scope === "user") {
    if (allowed) {
      relayRateLimitMetrics.agentsStreamPullCreditsGrantedUser += credits;
    } else {
      relayRateLimitMetrics.agentsStreamPullCreditsRejectedUser += credits;
    }
    return;
  }
  if (allowed) {
    relayRateLimitMetrics.agentsStreamPullCreditsGrantedAnon += credits;
  } else {
    relayRateLimitMetrics.agentsStreamPullCreditsRejectedAnon += credits;
  }
};

export const allowRelayConversationStart = (
  userSub: string | undefined,
  socketId: string,
): boolean => {
  if (env.socketRelayRateLimitMaxConversationStarts === 0) {
    return true;
  }

  const { key, scope } = buildIdentityKey(userSub, socketId);
  const state = ensureWindowState(key);
  if (state.conversationStarts >= env.socketRelayRateLimitMaxConversationStarts) {
    noteConversationStartDecision(scope, false);
    return false;
  }

  state.conversationStarts += 1;
  noteConversationStartDecision(scope, true);
  return true;
};

export const allowRelayConversationStartAsync = async (
  userSub: string | undefined,
  socketId: string,
): Promise<boolean> => {
  if (env.socketRelayRateLimitMaxConversationStarts === 0) {
    return true;
  }
  const { key, scope } = buildIdentityKey(userSub, socketId);
  const redisDecision = await consumeSocketRateLimitRedis({
    scope: "relay_conversation_start",
    key,
    windowMs: env.socketRelayRateLimitWindowMs,
    max: env.socketRelayRateLimitMaxConversationStarts,
  });
  if (redisDecision) {
    noteConversationStartDecision(scope, redisDecision.allowed);
    return redisDecision.allowed;
  }
  return allowRelayConversationStart(userSub, socketId);
};

export const refundRelayConversationStart = (
  userSub: string | undefined,
  socketId: string,
): void => {
  const { key } = buildIdentityKey(userSub, socketId);
  const state = statesByIdentityKey.get(key);
  if (!state || state.conversationStarts <= 0) {
    return;
  }
  state.conversationStarts -= 1;
};

export const refundRelayConversationStartAsync = async (
  userSub: string | undefined,
  socketId: string,
): Promise<void> => {
  const { key } = buildIdentityKey(userSub, socketId);
  await refundSocketRateLimitRedis({ scope: "relay_conversation_start", key });
  refundRelayConversationStart(userSub, socketId);
};

export const allowRelayRpcRequest = (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): boolean => {
  if (env.socketRelayRateLimitMaxRequests === 0) {
    return true;
  }

  const safeCost = Math.max(1, Math.floor(cost));
  const { key, scope } = buildIdentityKey(userSub, socketId);
  const state = ensureWindowState(key);
  if (state.relayRequests + safeCost > env.socketRelayRateLimitMaxRequests) {
    noteRelayRequestDecision(scope, false);
    return false;
  }

  state.relayRequests += safeCost;
  noteRelayRequestDecision(scope, true);
  return true;
};

export const allowRelayRpcRequestAsync = async (
  userSub: string | undefined,
  socketId: string,
  cost = 1,
): Promise<boolean> => {
  if (env.socketRelayRateLimitMaxRequests === 0) {
    return true;
  }
  const safeCost = Math.max(1, Math.floor(cost));
  const { key, scope } = buildIdentityKey(userSub, socketId);
  return consumeSocketRateLimitLocalFirstAsync(
    {
      scope: "relay_rpc_request",
      key,
      windowMs: env.socketRelayRateLimitWindowMs,
      max: env.socketRelayRateLimitMaxRequests,
      cost: safeCost,
    },
    {
      allowLocal: () => allowRelayRpcRequest(userSub, socketId, safeCost),
      refundLocal: () => refundRelayRpcRequest(userSub, socketId, safeCost),
      onLegacyRedisDecision: (allowed) => noteRelayRequestDecision(scope, allowed),
    },
  );
};

export const refundRelayRpcRequest = (
  userSub: string | undefined,
  socketId: string,
  count = 1,
): void => {
  const refund = Math.max(0, Math.floor(count));
  if (refund === 0) {
    return;
  }
  const { key } = buildIdentityKey(userSub, socketId);
  const state = statesByIdentityKey.get(key);
  if (!state || state.relayRequests <= 0) {
    return;
  }
  state.relayRequests = Math.max(0, state.relayRequests - refund);
};

export const refundRelayRpcRequestAsync = async (
  userSub: string | undefined,
  socketId: string,
  count = 1,
): Promise<void> => {
  const refund = Math.max(0, Math.floor(count));
  if (refund === 0) {
    return;
  }
  const { key } = buildIdentityKey(userSub, socketId);
  await refundSocketRateLimitRedis({ scope: "relay_rpc_request", key, cost: refund });
  refundRelayRpcRequest(userSub, socketId, refund);
};

const allowCreditWindow = (input: {
  readonly userSub: string | undefined;
  readonly socketId: string;
  readonly creditsRequested: number;
  readonly limit: number;
  readonly metricKind: "relay" | "agents";
  readonly memoryField: "streamPullCreditsGranted" | "agentsStreamPullCreditsGranted";
}): RelayStreamPullAllowance => {
  const { key, scope } = buildIdentityKey(input.userSub, input.socketId);
  const safeCreditsRequested = Math.max(0, Math.floor(input.creditsRequested));

  if (input.limit === 0) {
    if (safeCreditsRequested > 0) {
      if (input.metricKind === "relay") {
        noteRelayStreamPullCredits(scope, true, safeCreditsRequested);
      } else {
        noteAgentsStreamPullCredits(scope, true, safeCreditsRequested);
      }
    }
    return {
      allowed: true,
      scope,
      limit: 0,
      requestedCredits: safeCreditsRequested,
      grantedCredits: safeCreditsRequested,
      remainingCredits: Number.MAX_SAFE_INTEGER,
    };
  }

  const state = ensureWindowState(key);
  const used = state[input.memoryField];
  const remainingBefore = Math.max(0, input.limit - used);

  if (used + safeCreditsRequested > input.limit) {
    if (input.metricKind === "relay") {
      noteRelayStreamPullCredits(scope, false, safeCreditsRequested);
    } else {
      noteAgentsStreamPullCredits(scope, false, safeCreditsRequested);
    }
    return {
      allowed: false,
      scope,
      limit: input.limit,
      requestedCredits: safeCreditsRequested,
      grantedCredits: 0,
      remainingCredits: remainingBefore,
    };
  }

  state[input.memoryField] += safeCreditsRequested;
  if (input.metricKind === "relay") {
    noteRelayStreamPullCredits(scope, true, safeCreditsRequested);
  } else {
    noteAgentsStreamPullCredits(scope, true, safeCreditsRequested);
  }
  return {
    allowed: true,
    scope,
    limit: input.limit,
    requestedCredits: safeCreditsRequested,
    grantedCredits: safeCreditsRequested,
    remainingCredits: Math.max(0, input.limit - state[input.memoryField]),
  };
};

export const allowRelayStreamPull = (
  userSub: string | undefined,
  socketId: string,
  creditsRequested: number,
): RelayStreamPullAllowance =>
  allowCreditWindow({
    userSub,
    socketId,
    creditsRequested,
    limit: env.socketRelayRateLimitMaxStreamPullCredits,
    metricKind: "relay",
    memoryField: "streamPullCreditsGranted",
  });

export const allowRelayStreamPullAsync = async (
  userSub: string | undefined,
  socketId: string,
  creditsRequested: number,
): Promise<RelayStreamPullAllowance> => {
  const limit = env.socketRelayRateLimitMaxStreamPullCredits;
  const safeCreditsRequested = Math.max(0, Math.floor(creditsRequested));
  const { key, scope } = buildIdentityKey(userSub, socketId);
  if (limit > 0) {
    const redisDecision = await consumeSocketRateLimitRedis({
      scope: "relay_stream_pull_credits",
      key,
      windowMs: env.socketRelayRateLimitWindowMs,
      max: limit,
      cost: safeCreditsRequested,
    });
    if (redisDecision) {
      noteRelayStreamPullCredits(scope, redisDecision.allowed, safeCreditsRequested);
      return {
        allowed: redisDecision.allowed,
        scope,
        limit,
        requestedCredits: safeCreditsRequested,
        grantedCredits: redisDecision.allowed ? safeCreditsRequested : 0,
        remainingCredits: redisDecision.remaining,
      };
    }
  }
  return allowRelayStreamPull(userSub, socketId, creditsRequested);
};

export const refundRelayStreamPullCredits = (
  userSub: string | undefined,
  socketId: string,
  creditsToRefund: number,
): void => {
  const { key } = buildIdentityKey(userSub, socketId);
  const state = statesByIdentityKey.get(key);
  if (!state) {
    return;
  }
  state.streamPullCreditsGranted = Math.max(
    0,
    state.streamPullCreditsGranted - Math.max(0, Math.floor(creditsToRefund)),
  );
};

export const refundRelayStreamPullCreditsAsync = async (
  userSub: string | undefined,
  socketId: string,
  creditsToRefund: number,
): Promise<void> => {
  const { key } = buildIdentityKey(userSub, socketId);
  await refundSocketRateLimitRedis({
    scope: "relay_stream_pull_credits",
    key,
    cost: creditsToRefund,
  });
  refundRelayStreamPullCredits(userSub, socketId, creditsToRefund);
};

export const allowAgentsStreamPullCredits = async (
  userSub: string | undefined,
  socketId: string,
  creditsRequested: number,
): Promise<AgentsStreamPullAllowance> => {
  const limit = env.socketAgentsStreamPullRateLimitMaxCredits;
  const safeCreditsRequested = Math.max(0, Math.floor(creditsRequested));
  const { key, scope } = buildIdentityKey(userSub, socketId);
  if (limit > 0) {
    const redisDecision = await consumeSocketRateLimitRedis({
      scope: "agents_stream_pull_credits",
      key,
      windowMs: env.socketRelayRateLimitWindowMs,
      max: limit,
      cost: safeCreditsRequested,
    });
    if (redisDecision) {
      noteAgentsStreamPullCredits(scope, redisDecision.allowed, safeCreditsRequested);
      return {
        allowed: redisDecision.allowed,
        scope,
        limit,
        requestedCredits: safeCreditsRequested,
        grantedCredits: redisDecision.allowed ? safeCreditsRequested : 0,
        remainingCredits: redisDecision.remaining,
      };
    }
  }
  return allowCreditWindow({
    userSub,
    socketId,
    creditsRequested,
    limit,
    metricKind: "agents",
    memoryField: "agentsStreamPullCreditsGranted",
  });
};

export const refundAgentsStreamPullCredits = async (
  userSub: string | undefined,
  socketId: string,
  creditsToRefund: number,
): Promise<void> => {
  const { key } = buildIdentityKey(userSub, socketId);
  await refundSocketRateLimitRedis({
    scope: "agents_stream_pull_credits",
    key,
    cost: creditsToRefund,
  });
  const state = statesByIdentityKey.get(key);
  if (!state) {
    return;
  }
  state.agentsStreamPullCreditsGranted = Math.max(
    0,
    state.agentsStreamPullCreditsGranted - Math.max(0, Math.floor(creditsToRefund)),
  );
};

export const clearRelayRateLimitStateByConsumerSocket = (socketId: string): void => {
  const anonKey = `relay:anon:${socketId}`;
  statesByIdentityKey.delete(anonKey);
};

export const sweepRelayRateLimitState = (): void => {
  const nowMs = Date.now();
  const staleAfterMs =
    env.socketRelayRateLimitWindowMs * env.socketRelayRateLimitSweepStaleMultiplier;
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
  readonly maxStreamPullCredits: number;
  readonly maxAgentsStreamPullCredits: number;
  readonly activeIdentitiesTracked: number;
  readonly counters: RelayRateLimitMetrics;
} => ({
  windowMs: env.socketRelayRateLimitWindowMs,
  maxConversationStarts: env.socketRelayRateLimitMaxConversationStarts,
  maxRequests: env.socketRelayRateLimitMaxRequests,
  maxStreamPullCredits: env.socketRelayRateLimitMaxStreamPullCredits,
  maxAgentsStreamPullCredits: env.socketAgentsStreamPullRateLimitMaxCredits,
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
  relayRateLimitMetrics.agentsStreamPullCreditsGrantedUser = 0;
  relayRateLimitMetrics.agentsStreamPullCreditsRejectedUser = 0;
  relayRateLimitMetrics.agentsStreamPullCreditsGrantedAnon = 0;
  relayRateLimitMetrics.agentsStreamPullCreditsRejectedAnon = 0;
};
