import { serviceUnavailable } from "../../../shared/errors/http_errors";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { registerAgentFailure } from "./bridge_relay_health_metrics";
import type { StreamEventHandlers } from "./rest_pending_requests";
import { restSqlStreamMaterializeClearRequest } from "./rest_sql_stream_materialize";

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
  readonly onChunk: (payload: Record<string, unknown>) => void;
  readonly onComplete: (payload: Record<string, unknown>) => void;
  streamId?: string;
  restMaterializeState?: RestMaterializeStreamState;
}

const activeStreamsByRequestId = new Map<string, ActiveStreamRoute>();
const activeStreamsByStreamId = new Map<string, ActiveStreamRoute>();
const activeStreamRequestIdsByConversation = new Map<string, Set<string>>();
const streamRequestIdsByConsumer = new Map<string, Set<string>>();
const streamRequestIdsByAgent = new Map<string, Set<string>>();

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
export const countRestMaterializeStreamsInFlight = (): number => {
  let n = 0;
  for (const route of activeStreamsByRequestId.values()) {
    const mat = route.restMaterializeState;
    if (mat && !mat.settled) {
      n += 1;
    }
  }
  return n;
};

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

export const listActiveStreamRequestIdsForConversation = (conversationId: string): string[] =>
  Array.from(activeStreamRequestIdsByConversation.get(conversationId) ?? []);

const abortRestMaterializeIfPending = (route: ActiveStreamRoute): void => {
  const mat = route.restMaterializeState;
  if (!mat || mat.settled) {
    return;
  }
  mat.settled = true;
  clearTimeout(mat.timeoutHandle);
  registerAgentFailure(mat.agentId);
  mat.reject(serviceUnavailable("Agent disconnected while SQL stream in progress"));
};

/** Marks REST materialize as settled and clears its timeout without rejecting (caller rejects the HTTP promise). */
const detachRestMaterializeIfPending = (route: ActiveStreamRoute): void => {
  const mat = route.restMaterializeState;
  if (!mat || mat.settled) {
    return;
  }
  mat.settled = true;
  clearTimeout(mat.timeoutHandle);
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
  if (existing) {
    if (input.streamId) {
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

  addToIndex(streamRequestIdsByConsumer, route.consumerSocketId, route.requestId);
  addToIndex(streamRequestIdsByAgent, route.agentSocketId, route.requestId);

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
  const route = byStream ?? byRequest;
  if (!route || route.agentSocketId !== socketId) {
    return null;
  }

  if (streamId && !route.streamId) {
    route.streamId = streamId;
    activeStreamsByStreamId.set(streamId, route);
  }
  return route;
};

export const resetActiveStreamRegistry = (): void => {
  for (const route of activeStreamsByRequestId.values()) {
    abortRestMaterializeIfPending(route);
  }
  activeStreamsByRequestId.clear();
  activeStreamsByStreamId.clear();
  activeStreamRequestIdsByConversation.clear();
  streamRequestIdsByConsumer.clear();
  streamRequestIdsByAgent.clear();
};
