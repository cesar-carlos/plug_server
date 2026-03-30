/**
 * Per-agent inflight limit + FIFO wait queue for REST bridge dispatch (`dispatchRpcCommandToAgent`).
 * Isolated from `rpc_bridge.ts` to keep relay/stream logic separate.
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
const agentQueueById = new Map<string, AgentQueueWaiter[]>();

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
    totalQueued += q.length;
    maxDepth = Math.max(maxDepth, q.length);
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
  const inflight = getAgentInflight(agentId);
  if (inflight >= maxInflight) {
    return;
  }

  const queue = agentQueueById.get(agentId);
  if (!queue || queue.length === 0) {
    if (queue && queue.length === 0) {
      agentQueueById.delete(agentId);
    }
    return;
  }

  const next = queue.shift();
  if (queue.length === 0) {
    agentQueueById.delete(agentId);
  } else {
    agentQueueById.set(agentId, queue);
  }

  if (!next) {
    return;
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
  if (!queue || queue.length === 0) {
    return;
  }

  const index = queue.indexOf(waiter);
  if (index < 0) {
    return;
  }

  queue.splice(index, 1);
  if (queue.length === 0) {
    agentQueueById.delete(agentId);
  } else {
    agentQueueById.set(agentId, queue);
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

  const inflight = getAgentInflight(agentId);
  if (inflight < maxInflight) {
    setAgentInflight(agentId, inflight + 1);
    return () => {
      releaseAgentDispatchSlot(agentId);
    };
  }

  const queue = agentQueueById.get(agentId) ?? [];
  if (queue.length >= maxQueue) {
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

    queue.push(waiter);
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
