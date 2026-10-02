import { performance } from "node:perf_hooks";

import {
  createLatencyRingBuffer,
  latencyRingBufferValues,
  pushLatencyRingBuffer,
} from "../../../../shared/utils/latency_ring_buffer";
import { percentile } from "../../../../shared/utils/percentile";

const waitMsRingSize = 256;

type Waiter = {
  readonly resolve: (live: boolean) => void;
};

type PendingAdmit = {
  readonly admittedAtMs: number;
};

type SocketSequencerState = {
  readonly generation: number;
  nextAdmitSeq: number;
  nextCommitSeq: number;
  readonly waiters: Map<number, Waiter>;
  readonly pendingBySeq: Map<number, PendingAdmit>;
};

export interface AgentInboundAdmitTicket {
  readonly socketId: string;
  readonly seq: number;
  readonly generation: number;
}

export interface AgentInboundSequencerMetricsSnapshot {
  readonly waitMsSum: number;
  readonly waitMsCount: number;
  readonly waitMsMax: number;
  readonly waitMsP95: number;
  readonly outOfOrderPreventedTotal: number;
  readonly chunkWithoutRouteTotal: number;
  readonly pendingJobs: number;
  readonly oldestPendingAgeMs: number;
}

const metrics = {
  waitMsSum: 0,
  waitMsCount: 0,
  waitMsMax: 0,
  waitRing: createLatencyRingBuffer(waitMsRingSize),
  outOfOrderPreventedTotal: 0,
  chunkWithoutRouteTotal: 0,
};

const stateBySocketId = new Map<string, SocketSequencerState>();
// Unique across idle pruning, disconnect and resets without retaining historical socket ids.
let nextGeneration = 0;

const getOrCreateState = (socketId: string): SocketSequencerState => {
  const existing = stateBySocketId.get(socketId);
  if (existing) {
    return existing;
  }
  const created: SocketSequencerState = {
    generation: ++nextGeneration,
    nextAdmitSeq: 0,
    nextCommitSeq: 0,
    waiters: new Map(),
    pendingBySeq: new Map(),
  };
  stateBySocketId.set(socketId, created);
  return created;
};

const pruneIfIdle = (socketId: string, state: SocketSequencerState): void => {
  if (state.pendingBySeq.size > 0 || state.waiters.size > 0) {
    return;
  }
  if (state.nextAdmitSeq === state.nextCommitSeq) {
    stateBySocketId.delete(socketId);
  }
};

export const admitAgentInboundFrameSeq = (socketId: string): AgentInboundAdmitTicket => {
  const state = getOrCreateState(socketId);
  const seq = state.nextAdmitSeq;
  state.nextAdmitSeq += 1;
  state.pendingBySeq.set(seq, { admittedAtMs: performance.now() });
  return { socketId, seq, generation: state.generation };
};

const observeWaitMs = (waitedMs: number): void => {
  const bounded = Math.max(0, waitedMs);
  metrics.waitMsSum += bounded;
  metrics.waitMsCount += 1;
  metrics.waitMsMax = Math.max(metrics.waitMsMax, bounded);
  pushLatencyRingBuffer(metrics.waitRing, bounded);
};

export const waitAgentInboundCommitTurn = async (
  ticket: AgentInboundAdmitTicket,
): Promise<"live" | "stale"> => {
  const state = stateBySocketId.get(ticket.socketId);
  if (!state || state.generation !== ticket.generation) {
    return "stale";
  }
  if (ticket.seq < state.nextCommitSeq) {
    return "stale";
  }
  if (ticket.seq === state.nextCommitSeq) {
    observeWaitMs(0);
    return "live";
  }
  metrics.outOfOrderPreventedTotal += 1;
  const startedWait = performance.now();
  return new Promise<"live" | "stale">((resolve) => {
    state.waiters.set(ticket.seq, {
      resolve: (live) => {
        observeWaitMs(performance.now() - startedWait);
        resolve(live ? "live" : "stale");
      },
    });
  });
};

export const isAgentInboundTicketCurrent = (ticket: AgentInboundAdmitTicket): boolean => {
  const state = stateBySocketId.get(ticket.socketId);
  return state !== undefined && state.generation === ticket.generation;
};

export const completeAgentInboundCommitTurn = (ticket: AgentInboundAdmitTicket): void => {
  const state = stateBySocketId.get(ticket.socketId);
  if (!state || state.generation !== ticket.generation) {
    return;
  }
  if (ticket.seq !== state.nextCommitSeq) {
    return;
  }
  state.pendingBySeq.delete(ticket.seq);
  state.nextCommitSeq += 1;
  const nextWaiter = state.waiters.get(state.nextCommitSeq);
  if (nextWaiter) {
    state.waiters.delete(state.nextCommitSeq);
    nextWaiter.resolve(true);
  }
  pruneIfIdle(ticket.socketId, state);
};

export const noteAgentInboundChunkWithoutRoute = (): void => {
  metrics.chunkWithoutRouteTotal += 1;
};

export const cleanupAgentInboundSequencerSocket = (socketId: string): void => {
  const state = stateBySocketId.get(socketId);
  if (!state) {
    return;
  }
  stateBySocketId.delete(socketId);
  for (const waiter of state.waiters.values()) {
    waiter.resolve(false);
  }
  state.waiters.clear();
  state.pendingBySeq.clear();
  state.nextAdmitSeq = 0;
  state.nextCommitSeq = 0;
};

export const getAgentInboundSequencerMetricsSnapshot = (): AgentInboundSequencerMetricsSnapshot => {
  let pendingJobs = 0;
  let oldestAdmittedAtMs = Number.POSITIVE_INFINITY;
  const now = performance.now();
  for (const state of stateBySocketId.values()) {
    pendingJobs += state.pendingBySeq.size;
    for (const pending of state.pendingBySeq.values()) {
      if (pending.admittedAtMs < oldestAdmittedAtMs) {
        oldestAdmittedAtMs = pending.admittedAtMs;
      }
    }
  }
  const waitSamples = latencyRingBufferValues(metrics.waitRing);
  return {
    waitMsSum: metrics.waitMsSum,
    waitMsCount: metrics.waitMsCount,
    waitMsMax: metrics.waitMsMax,
    waitMsP95: waitSamples.length === 0 ? 0 : Number(percentile(waitSamples, 95).toFixed(4)),
    outOfOrderPreventedTotal: metrics.outOfOrderPreventedTotal,
    chunkWithoutRouteTotal: metrics.chunkWithoutRouteTotal,
    pendingJobs,
    oldestPendingAgeMs:
      pendingJobs === 0 || !Number.isFinite(oldestAdmittedAtMs)
        ? 0
        : Math.max(0, now - oldestAdmittedAtMs),
  };
};

export const resetAgentInboundSequencerForTests = (): void => {
  for (const socketId of stateBySocketId.keys()) cleanupAgentInboundSequencerSocket(socketId);
  metrics.waitMsSum = 0;
  metrics.waitMsCount = 0;
  metrics.waitMsMax = 0;
  metrics.waitRing = createLatencyRingBuffer(waitMsRingSize);
  metrics.outOfOrderPreventedTotal = 0;
  metrics.chunkWithoutRouteTotal = 0;
};

/** Internal cardinality diagnostic, never included in socket event envelopes. */
export const getAgentInboundSequencerTrackedSocketCount = (): number => stateBySocketId.size;
