/**
 * Per-agent inflight limit + FIFO wait queue for REST bridge dispatch (`dispatchRpcCommandToAgent`).
 * Isolated from `rpc_bridge.ts` to keep relay/stream logic separate.
 *
 * `SOCKET_REST_AGENT_MAX_INFLIGHT=0` disables inflight + queue enforcement (returns immediately).
 * `SOCKET_REST_AGENT_MAX_QUEUE=0` allows unlimited wait-queue depth (still uses `SOCKET_REST_AGENT_QUEUE_WAIT_MS` timeouts).
 */

import { env } from "../../../shared/config/env";
import {
  serviceUnavailable,
  serviceUnavailableWithRetry,
} from "../../../shared/errors/http_errors";

const withAppendedMessage = (base: string, extra: string): string =>
  extra.trim() === "" ? base : `${base}. ${extra}`;

interface AgentQueueWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly enqueuedAtMs: number;
  readonly timeoutHandle: NodeJS.Timeout;
}

const maxInflight = env.socketRestAgentMaxInflight;
const maxQueue = env.socketRestAgentMaxQueue;
const queueWaitMs = env.socketRestAgentQueueWaitMs;

const agentInflightById = new Map<string, number>();
/**
 * Per-agent FIFO wait queue backed by a `Set` so removal at any position is O(1)
 * (vs the previous `Array.indexOf + splice` which was O(queue depth)).
 * Set iteration order is insertion order, giving stable FIFO dequeue via the iterator.
 */
const agentQueueById = new Map<string, Set<AgentQueueWaiter>>();

export type RestAgentDispatchQueueRejectReason = "queue_full" | "queue_wait_timeout";

let onRestDispatchQueueReject: (reason: RestAgentDispatchQueueRejectReason) => void = () => {};

/** Wire metric hook (typically increments granular `relayMetrics.restAgentQueue*` counters). */
export const wireRestAgentDispatchQueueMetrics = (
  fn: (reason: RestAgentDispatchQueueRejectReason) => void,
): void => {
  onRestDispatchQueueReject = fn;
};

export const getRestAgentDispatchQueueMetricsSnapshot = (): {
  readonly agentsWithQueuedWaiters: number;
  readonly totalQueuedWaiters: number;
  readonly totalInflight: number;
  readonly maxQueueDepthPerAgent: number;
} => {
  let totalQueued = 0;
  let maxDepth = 0;
  for (const q of agentQueueById.values()) {
    totalQueued += q.size;
    maxDepth = Math.max(maxDepth, q.size);
  }
  let totalInflight = 0;
  for (const v of agentInflightById.values()) {
    totalInflight += v;
  }
  return {
    agentsWithQueuedWaiters: agentQueueById.size,
    totalQueuedWaiters: totalQueued,
    totalInflight,
    maxQueueDepthPerAgent: maxDepth,
  };
};

const getAgentInflight = (agentId: string): number => agentInflightById.get(agentId) ?? 0;

const setAgentInflight = (agentId: string, value: number): void => {
  if (value <= 0) {
    agentInflightById.delete(agentId);
    return;
  }
  agentInflightById.set(agentId, value);
};

const drainAgentQueue = (agentId: string): void => {
  if (maxInflight <= 0) {
    return;
  }
  const inflight = getAgentInflight(agentId);
  if (inflight >= maxInflight) {
    return;
  }

  const queue = agentQueueById.get(agentId);
  if (!queue || queue.size === 0) {
    if (queue) {
      agentQueueById.delete(agentId);
    }
    return;
  }

  // Set preserves insertion order; the iterator yields the oldest entry first (FIFO).
  const [next] = queue;
  if (!next) {
    return;
  }
  queue.delete(next);
  if (queue.size === 0) {
    agentQueueById.delete(agentId);
  }

  clearTimeout(next.timeoutHandle);
  setAgentInflight(agentId, inflight + 1);
  next.resolve();
};

const releaseAgentDispatchSlot = (agentId: string): void => {
  const current = getAgentInflight(agentId);
  setAgentInflight(agentId, current - 1);
  drainAgentQueue(agentId);
};

const removeQueuedWaiter = (agentId: string, waiter: AgentQueueWaiter): void => {
  const queue = agentQueueById.get(agentId);
  if (!queue) {
    return;
  }
  queue.delete(waiter); // O(1) — no indexOf scan or element shift
  if (queue.size === 0) {
    agentQueueById.delete(agentId);
  }
};

/**
 * Acquires a dispatch slot for the agent. Returns `release` to call in `finally` when the RPC completes.
 */
export const acquireRestAgentDispatchSlot = async (
  agentId: string,
  signal?: AbortSignal,
): Promise<() => void> => {
  if (signal?.aborted) {
    throw serviceUnavailable("HTTP request aborted by client");
  }

  if (maxInflight <= 0) {
    return () => {};
  }

  const inflight = getAgentInflight(agentId);
  if (inflight < maxInflight) {
    setAgentInflight(agentId, inflight + 1);
    return () => {
      releaseAgentDispatchSlot(agentId);
    };
  }

  const queue = agentQueueById.get(agentId) ?? new Set<AgentQueueWaiter>();
  if (maxQueue > 0 && queue.size >= maxQueue) {
    onRestDispatchQueueReject("queue_full");
    throw serviceUnavailableWithRetry(
      withAppendedMessage("Agent is overloaded", "queue is full"),
      queueWaitMs,
    );
  }

  const release = await new Promise<() => void>((resolve, reject) => {
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signalListener) {
        signal?.removeEventListener("abort", signalListener);
      }
      reject(error);
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signalListener) {
        signal?.removeEventListener("abort", signalListener);
      }
      resolve(() => {
        releaseAgentDispatchSlot(agentId);
      });
    };

    const waiterHolder: { current?: AgentQueueWaiter } = {};
    const timeoutHandle = setTimeout(() => {
      const w = waiterHolder.current;
      if (w) {
        removeQueuedWaiter(agentId, w);
      }
      onRestDispatchQueueReject("queue_wait_timeout");
      rejectOnce(
        serviceUnavailableWithRetry(
          withAppendedMessage("Agent is overloaded", "queue wait timeout"),
          queueWaitMs,
        ),
      );
    }, queueWaitMs);

    const waiter: AgentQueueWaiter = {
      resolve: resolveOnce,
      reject: rejectOnce,
      enqueuedAtMs: Date.now(),
      timeoutHandle,
    };
    waiterHolder.current = waiter;

    const signalListener = signal
      ? () => {
          clearTimeout(timeoutHandle);
          removeQueuedWaiter(agentId, waiter);
          rejectOnce(serviceUnavailable("HTTP request aborted by client"));
        }
      : null;

    queue.add(waiter);
    agentQueueById.set(agentId, queue);
    if (signal && signalListener) {
      signal.addEventListener("abort", signalListener, { once: true });
    }
  });

  return release;
};

/** Rejects all queued waiters and clears inflight (e.g. bridge reset). */
export const resetRestAgentDispatchQueue = (rejectReason: Error): void => {
  agentInflightById.clear();
  for (const queue of agentQueueById.values()) {
    for (const waiter of queue) {
      clearTimeout(waiter.timeoutHandle);
      waiter.reject(rejectReason);
    }
  }
  agentQueueById.clear();
};
