import type { BridgeLatencyTraceSession } from "../../../application/services/bridge_latency_trace_builder";

export interface StreamEventHandlers {
  readonly consumerSocketId: string;
  readonly conversationId?: string;
  readonly mode?: "legacy" | "relay";
  readonly onChunk: (payload: Record<string, unknown>) => void;
  readonly onComplete: (payload: Record<string, unknown>) => void;
}

export interface PendingRequest {
  readonly primaryRequestId: string;
  readonly correlationIds: readonly string[];
  readonly socketId: string;
  readonly agentId: string;
  readonly createdAtMs: number;
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutHandle: NodeJS.Timeout;
  readonly streamHandlers?: StreamEventHandlers;
  /** When true (REST bridge, single `sql.execute`), defer HTTP resolve until stream is merged via pull+chunks+complete. */
  readonly restStreamAggregate?: boolean;
  readonly latencyTrace?: BridgeLatencyTraceSession;
  acked: boolean;
}

const pendingByCorrelationId = new Map<string, PendingRequest>();
let logicalPendingCount = 0;

export const registerRestPendingRequest = (pending: PendingRequest): void => {
  for (const requestId of pending.correlationIds) {
    pendingByCorrelationId.set(requestId, pending);
  }
  logicalPendingCount += 1;
};

export const clearRestPendingRequest = (pending: PendingRequest): void => {
  let removed = false;
  for (const requestId of pending.correlationIds) {
    const existing = pendingByCorrelationId.get(requestId);
    if (existing === pending) {
      pendingByCorrelationId.delete(requestId);
      removed = true;
    }
  }

  if (removed) {
    logicalPendingCount = Math.max(0, logicalPendingCount - 1);
  }
};

export const findRestPendingRequestByIds = (
  socketId: string,
  ids: readonly string[],
): PendingRequest | null => {
  for (const id of ids) {
    const pending = pendingByCorrelationId.get(id);
    if (pending && pending.socketId === socketId) {
      return pending;
    }
  }
  return null;
};

export const getRestPendingRequestByCorrelationId = (correlationId: string): PendingRequest | undefined =>
  pendingByCorrelationId.get(correlationId);

export const hasRestPendingCorrelationId = (correlationId: string): boolean =>
  pendingByCorrelationId.has(correlationId);

export const getRestPendingRequestCount = (): number => logicalPendingCount;

/** Invokes `fn` once per distinct `PendingRequest` (map may alias the same object under several correlation ids). */
export const forEachUniqueRestPendingRequest = (fn: (pending: PendingRequest) => void): void => {
  const seen = new Set<PendingRequest>();
  for (const pending of pendingByCorrelationId.values()) {
    if (!seen.has(pending)) {
      seen.add(pending);
      fn(pending);
    }
  }
};

export const resetRestPendingRequestsStore = (): void => {
  pendingByCorrelationId.clear();
  logicalPendingCount = 0;
};
