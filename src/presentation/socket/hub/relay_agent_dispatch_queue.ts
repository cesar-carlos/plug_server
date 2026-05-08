/**
 * Per-agent inflight limit + FIFO wait queue for relay `rpc:request` dispatch.
 *
 * `SOCKET_RELAY_AGENT_MAX_INFLIGHT=0` disables inflight + queue enforcement.
 * `SOCKET_RELAY_AGENT_MAX_QUEUE=0` allows unlimited wait-queue depth.
 */

import { env } from "../../../shared/config/env";
import { serviceUnavailable, serviceUnavailableWithRetry } from "../../../shared/errors/http_errors";

interface AgentQueueWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeoutHandle: NodeJS.Timeout;
}

const maxInflight = env.socketRelayAgentMaxInflight;
const maxQueue = env.socketRelayAgentMaxQueue;
const queueWaitMs = env.socketRelayAgentQueueWaitMs;

const agentInflightById = new Map<string, number>();
const agentQueueById = new Map<string, AgentQueueWaiter[]>();

const metrics = {
  queueFullRejected: 0,
  queueWaitTimeoutRejected: 0,
};

const getAgentInflight = (agentId: string): number => agentInflightById.get(agentId) ?? 0;

const setAgentInflight = (agentId: string, value: number): void => {
  if (value <= 0) {
    agentInflightById.delete(agentId);
    return;
  }
  agentInflightById.set(agentId, value);
};

const removeQueuedWaiter = (agentId: string, waiter: AgentQueueWaiter): void => {
  const queue = agentQueueById.get(agentId);
  if (!queue) {
    return;
  }
  const index = queue.indexOf(waiter);
  if (index < 0) {
    return;
  }
  queue.splice(index, 1);
  if (queue.length === 0) {
    agentQueueById.delete(agentId);
  }
};

const drainAgentQueue = (agentId: string): void => {
  if (maxInflight <= 0 || getAgentInflight(agentId) >= maxInflight) {
    return;
  }

  const queue = agentQueueById.get(agentId);
  const next = queue?.shift();
  if (queue && queue.length === 0) {
    agentQueueById.delete(agentId);
  }
  if (!next) {
    return;
  }

  clearTimeout(next.timeoutHandle);
  setAgentInflight(agentId, getAgentInflight(agentId) + 1);
  next.resolve();
};

const releaseAgentDispatchSlot = (agentId: string): void => {
  setAgentInflight(agentId, getAgentInflight(agentId) - 1);
  drainAgentQueue(agentId);
};

const idempotentRelease = (agentId: string): (() => void) => {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseAgentDispatchSlot(agentId);
  };
};

export const acquireRelayAgentDispatchSlot = async (
  agentId: string,
  signal?: AbortSignal,
): Promise<() => void> => {
  if (signal?.aborted) {
    throw serviceUnavailable("Consumer socket disconnected before relay dispatch completed");
  }

  if (maxInflight <= 0) {
    return () => {};
  }

  const inflight = getAgentInflight(agentId);
  if (inflight < maxInflight) {
    setAgentInflight(agentId, inflight + 1);
    return idempotentRelease(agentId);
  }

  const queue = agentQueueById.get(agentId) ?? [];
  if (maxQueue > 0 && queue.length >= maxQueue) {
    metrics.queueFullRejected += 1;
    throw serviceUnavailableWithRetry("Agent relay dispatch is overloaded; queue is full", queueWaitMs);
  }

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const waiterHolder: { current?: AgentQueueWaiter } = {};
    const signalListener = signal
      ? () => {
          const waiter = waiterHolder.current;
          if (waiter) {
            clearTimeout(waiter.timeoutHandle);
            removeQueuedWaiter(agentId, waiter);
          }
          rejectOnce(
            serviceUnavailable("Consumer socket disconnected before relay dispatch completed"),
          );
        }
      : null;

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
      resolve(idempotentRelease(agentId));
    };

    const timeoutHandle = setTimeout(() => {
      removeQueuedWaiter(agentId, waiter);
      metrics.queueWaitTimeoutRejected += 1;
      rejectOnce(
        serviceUnavailableWithRetry(
          "Agent relay dispatch is overloaded; queue wait timeout",
          queueWaitMs,
        ),
      );
    }, queueWaitMs);

    const waiter: AgentQueueWaiter = {
      resolve: resolveOnce,
      reject: rejectOnce,
      timeoutHandle,
    };
    waiterHolder.current = waiter;

    queue.push(waiter);
    agentQueueById.set(agentId, queue);
    if (signal && signalListener) {
      signal.addEventListener("abort", signalListener, { once: true });
    }
  });
};

export const getRelayAgentDispatchQueueMetricsSnapshot = (): {
  readonly agentsWithQueuedWaiters: number;
  readonly totalQueuedWaiters: number;
  readonly totalInflight: number;
  readonly maxQueueDepthPerAgent: number;
  readonly queueFullRejected: number;
  readonly queueWaitTimeoutRejected: number;
} => {
  let totalQueuedWaiters = 0;
  let maxQueueDepthPerAgent = 0;
  for (const queue of agentQueueById.values()) {
    totalQueuedWaiters += queue.length;
    maxQueueDepthPerAgent = Math.max(maxQueueDepthPerAgent, queue.length);
  }
  let totalInflight = 0;
  for (const inflight of agentInflightById.values()) {
    totalInflight += inflight;
  }
  return {
    agentsWithQueuedWaiters: agentQueueById.size,
    totalQueuedWaiters,
    totalInflight,
    maxQueueDepthPerAgent,
    queueFullRejected: metrics.queueFullRejected,
    queueWaitTimeoutRejected: metrics.queueWaitTimeoutRejected,
  };
};

export const resetRelayAgentDispatchQueue = (rejectReason: Error): void => {
  agentInflightById.clear();
  for (const queue of agentQueueById.values()) {
    for (const waiter of queue) {
      clearTimeout(waiter.timeoutHandle);
      waiter.reject(rejectReason);
    }
  }
  agentQueueById.clear();
  metrics.queueFullRejected = 0;
  metrics.queueWaitTimeoutRejected = 0;
};
