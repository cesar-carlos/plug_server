import { serviceUnavailable } from "../../../../shared/errors/http_errors";
import { toRequestId } from "../../../../shared/utils/rpc_types";
import { registerAgentFailure } from "../relay/bridge_relay_health_metrics";
import type { StreamEventHandlers } from "./rest_pending_requests";
import { restSqlStreamMaterializeClearRequest } from "../relay/rest_sql_stream_materialize";
import {
  clearRelayStreamTimeouts,
  resetRelayStreamTimeouts,
} from "./relay_stream_timeout_registry";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

/** In-flight REST materialized `sql.execute` stream: fail-fast if route is torn down before `rpc:complete`. */
export type RestMaterializeStreamState = {
  settled: boolean;
  timeoutHandle: NodeJS.Timeout;
  reject: (error: Error) => void;
  agentId: string;
};

export interface ActiveStreamRoute {
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly requestId: string;
  readonly conversationId?: string;
  readonly mode: "legacy" | "relay";
  readonly onChunk: StreamEventHandlers["onChunk"];
  readonly onComplete: (payload: Record<string, unknown>) => void;
  streamId?: string;
  restMaterializeState?: RestMaterializeStreamState;
}

const activeStreamsByRequestId = new Map<string, ActiveStreamRoute>();
const activeStreamsByStreamId = new Map<string, ActiveStreamRoute>();
const activeStreamRequestIdsByConversation = new Map<string, Set<string>>();
const streamRequestIdsByConsumer = new Map<string, Set<string>>();
const streamRequestIdsByAgent = new Map<string, Set<string>>();
/**
 * O(1) counter of routes where `streamId` has been assigned for a given agent socket.
 * Maintained in lockstep with `activeStreamsByStreamId` to avoid O(n) scans in
 * `countOpenStreamRoutesForAgent`, which is called on every `rpc:response` that
 * opens a new stream.
 */
const openStreamCountByAgentSocketId = new Map<string, number>();
let restMaterializeStreamsInFlight = 0;

const incrementOpenStreamCount = (agentSocketId: string): void => {
  openStreamCountByAgentSocketId.set(
    agentSocketId,
    (openStreamCountByAgentSocketId.get(agentSocketId) ?? 0) + 1,
  );
};

const decrementOpenStreamCount = (agentSocketId: string): void => {
  const current = openStreamCountByAgentSocketId.get(agentSocketId);
  if (current === undefined || current <= 1) {
    openStreamCountByAgentSocketId.delete(agentSocketId);
    return;
  }
  openStreamCountByAgentSocketId.set(agentSocketId, current - 1);
};

const addToIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  index.set(key, new Set([value]));
};

const removeFromIndex = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (!existing) {
    return;
  }

  existing.delete(value);
  if (existing.size === 0) {
    index.delete(key);
  }
};

const pickRequestIdFromStreamPayload = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  return toRequestId(record.request_id);
};

const pickStreamIdFromStreamPayload = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  return toRequestId(record.stream_id);
};

export const getActiveStreamRouteCount = (): number => activeStreamsByRequestId.size;

/** Active REST SQL stream materializations awaiting `rpc:complete` (not yet settled). */
export const countRestMaterializeStreamsInFlight = (): number => restMaterializeStreamsInFlight;

export const getActiveStreamRouteByRequestId = (requestId: string): ActiveStreamRoute | undefined =>
  activeStreamsByRequestId.get(requestId);

export const getActiveStreamRouteByStreamId = (streamId: string): ActiveStreamRoute | undefined =>
  activeStreamsByStreamId.get(streamId);

export const hasActiveStreamRouteForRequestId = (requestId: string): boolean =>
  activeStreamsByRequestId.has(requestId);

export const listStreamRequestIdsForConsumer = (consumerSocketId: string): string[] =>
  Array.from(streamRequestIdsByConsumer.get(consumerSocketId) ?? []);

export const listStreamRequestIdsForAgent = (agentSocketId: string): string[] =>
  Array.from(streamRequestIdsByAgent.get(agentSocketId) ?? []);

export const countStreamRoutesForAgent = (agentSocketId: string): number =>
  streamRequestIdsByAgent.get(agentSocketId)?.size ?? 0;

export const countOpenStreamRoutesForAgent = (agentSocketId: string): number =>
  openStreamCountByAgentSocketId.get(agentSocketId) ?? 0;

export const listActiveStreamRequestIdsForConversation = (conversationId: string): string[] =>
  Array.from(activeStreamRequestIdsByConversation.get(conversationId) ?? []);

const abortRestMaterializeIfPending = (route: ActiveStreamRoute): void => {
  const mat = route.restMaterializeState;
  if (!mat || mat.settled) {
    return;
  }
  mat.settled = true;
  restMaterializeStreamsInFlight = Math.max(0, restMaterializeStreamsInFlight - 1);
  clearTimeout(mat.timeoutHandle);
  registerAgentFailure(mat.agentId, "rest");
  mat.reject(serviceUnavailable("Agent disconnected while SQL stream in progress"));
};

/** Marks REST materialize as settled and clears its timeout without rejecting (caller rejects the HTTP promise). */
const detachRestMaterializeIfPending = (route: ActiveStreamRoute): void => {
  const mat = route.restMaterializeState;
  if (!mat || mat.settled) {
    return;
  }
  mat.settled = true;
  restMaterializeStreamsInFlight = Math.max(0, restMaterializeStreamsInFlight - 1);
  clearTimeout(mat.timeoutHandle);
};

/**
 * Success-path settle for REST SQL stream materialization: decrements the
 * in-flight gauge and clears the materialize timeout. Safe to call before
 * `removeActiveStreamRoute` (which no-ops when already settled).
 */
export const settleRestMaterializeSuccess = (route: ActiveStreamRoute): void => {
  detachRestMaterializeIfPending(route);
};

export type RemoveActiveStreamRouteOptions = {
  /**
   * `abort` (default): if REST materialization is still in flight, reject the HTTP promise.
   * `detach`: only clear the materialize timer; use when the caller calls `reject` immediately after (timeout, HTTP abort, emit error).
   */
  readonly restMaterialize?: "abort" | "detach";
};

export const removeActiveStreamRoute = (
  route: ActiveStreamRoute,
  options?: RemoveActiveStreamRouteOptions,
): void => {
  clearRelayStreamTimeouts(route.requestId);
  const restMode = options?.restMaterialize ?? "abort";
  if (restMode === "detach") {
    detachRestMaterializeIfPending(route);
  } else {
    abortRestMaterializeIfPending(route);
  }
  restSqlStreamMaterializeClearRequest(route.requestId);
  activeStreamsByRequestId.delete(route.requestId);
  if (route.streamId) {
    activeStreamsByStreamId.delete(route.streamId);
    decrementOpenStreamCount(route.agentSocketId);
  }
  if (route.conversationId) {
    removeFromIndex(activeStreamRequestIdsByConversation, route.conversationId, route.requestId);
  }
  removeFromIndex(streamRequestIdsByConsumer, route.consumerSocketId, route.requestId);
  removeFromIndex(streamRequestIdsByAgent, route.agentSocketId, route.requestId);
};

export const upsertActiveStreamRoute = (input: {
  readonly requestId: string;
  readonly agentSocketId: string;
  readonly streamHandlers: StreamEventHandlers;
  readonly streamId?: string;
  readonly restMaterializeState?: RestMaterializeStreamState;
}): ActiveStreamRoute => {
  const existing = activeStreamsByRequestId.get(input.requestId);
  const existingByStreamId = input.streamId
    ? activeStreamsByStreamId.get(input.streamId)
    : undefined;
  if (existingByStreamId && existingByStreamId.requestId !== input.requestId) {
    throw new Error("Active stream id is already registered for another request");
  }

  if (existing) {
    if (existing.agentSocketId !== input.agentSocketId) {
      throw new Error("Active stream route agent socket mismatch");
    }
    if (input.restMaterializeState && !existing.restMaterializeState) {
      restMaterializeStreamsInFlight += 1;
    }
    if (input.streamId) {
      if (existing.streamId && existing.streamId !== input.streamId) {
        activeStreamsByStreamId.delete(existing.streamId);
        // streamId is being replaced (still set) — counter unchanged
      }
      if (!existing.streamId) {
        // Transitioning from no streamId → has streamId for the first time
        incrementOpenStreamCount(input.agentSocketId);
      }
      existing.streamId = input.streamId;
    }
    activeStreamsByRequestId.set(input.requestId, existing);
    if (existing.streamId) {
      activeStreamsByStreamId.set(existing.streamId, existing);
    }
    return existing;
  }

  const route: ActiveStreamRoute = {
    consumerSocketId: input.streamHandlers.consumerSocketId,
    agentSocketId: input.agentSocketId,
    requestId: input.requestId,
    ...(input.streamHandlers.conversationId
      ? { conversationId: input.streamHandlers.conversationId }
      : {}),
    mode: input.streamHandlers.mode ?? "legacy",
    onChunk: input.streamHandlers.onChunk,
    onComplete: input.streamHandlers.onComplete,
    ...(input.streamId ? { streamId: input.streamId } : {}),
    ...(input.restMaterializeState ? { restMaterializeState: input.restMaterializeState } : {}),
  };

  if (input.restMaterializeState) {
    restMaterializeStreamsInFlight += 1;
  }

  addToIndex(streamRequestIdsByConsumer, route.consumerSocketId, route.requestId);
  addToIndex(streamRequestIdsByAgent, route.agentSocketId, route.requestId);
  if (route.streamId) {
    incrementOpenStreamCount(route.agentSocketId);
  }

  activeStreamsByRequestId.set(route.requestId, route);
  if (route.streamId) {
    activeStreamsByStreamId.set(route.streamId, route);
  }
  if (route.conversationId) {
    addToIndex(activeStreamRequestIdsByConversation, route.conversationId, route.requestId);
  }
  return route;
};

export const resolveActiveStreamRoute = (
  socketId: string,
  payload: unknown,
): ActiveStreamRoute | null => {
  const streamId = pickStreamIdFromStreamPayload(payload);
  const requestId = pickRequestIdFromStreamPayload(payload);
  const byStream = streamId ? activeStreamsByStreamId.get(streamId) : undefined;
  const byRequest = requestId ? activeStreamsByRequestId.get(requestId) : undefined;
  if (byStream && byRequest && byStream !== byRequest) {
    return null;
  }
  const route = byStream ?? byRequest;
  if (!route || route.agentSocketId !== socketId) {
    return null;
  }

  if (streamId && !route.streamId) {
    route.streamId = streamId;
    activeStreamsByStreamId.set(streamId, route);
    incrementOpenStreamCount(route.agentSocketId);
  }
  return route;
};

export const resetActiveStreamRegistry = (): void => {
  for (const route of activeStreamsByRequestId.values()) {
    abortRestMaterializeIfPending(route);
  }
  resetRelayStreamTimeouts();
  activeStreamsByRequestId.clear();
  activeStreamsByStreamId.clear();
  activeStreamRequestIdsByConversation.clear();
  streamRequestIdsByConsumer.clear();
  streamRequestIdsByAgent.clear();
  openStreamCountByAgentSocketId.clear();
  restMaterializeStreamsInFlight = 0;
};
