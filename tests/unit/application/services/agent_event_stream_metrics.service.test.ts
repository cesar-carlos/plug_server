import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentEventStreamMetricsSnapshot,
  noteAgentEventStreamAck,
  noteAgentEventStreamAppend,
  noteAgentEventStreamBacklogRead,
  noteAgentEventStreamBatchAppend,
  noteAgentEventStreamBatchPartialFailure,
  noteAgentEventStreamConnected,
  noteAgentEventStreamDisconnected,
  noteAgentEventStreamDropped,
  noteAgentEventStreamFallback,
  noteAgentEventStreamSkippedEmptyUrl,
  observeAgentEventStreamLatency,
  resetAgentEventStreamMetricsForTests,
} from "../../../../src/application/services/agent_event_stream_metrics.service";

describe("agent_event_stream_metrics", () => {
  afterEach(() => {
    resetAgentEventStreamMetricsForTests();
  });

  it("starts skipped (urlConfigured=0)", () => {
    noteAgentEventStreamSkippedEmptyUrl();
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.redisUrlConfigured).toBe(0);
    expect(snapshot.redisStoreActive).toBe(0);
    expect(snapshot.appendsTotal).toBe(0);
  });

  it("counts append/read/ack/dropped events", () => {
    noteAgentEventStreamConnected();
    noteAgentEventStreamAppend();
    noteAgentEventStreamAppend();
    noteAgentEventStreamBacklogRead(3);
    noteAgentEventStreamBacklogRead(0);
    noteAgentEventStreamAck();
    noteAgentEventStreamDropped();
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.redisStoreActive).toBe(1);
    expect(snapshot.appendsTotal).toBe(2);
    expect(snapshot.backlogReadsTotal).toBe(2);
    expect(snapshot.backlogEntriesDeliveredTotal).toBe(3);
    expect(snapshot.acksTotal).toBe(1);
    expect(snapshot.droppedTotal).toBe(1);
  });

  it("fallback transitions store to inactive but keeps URL configured", () => {
    noteAgentEventStreamConnected();
    noteAgentEventStreamFallback();
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.redisUrlConfigured).toBe(1);
    expect(snapshot.redisStoreActive).toBe(0);
    expect(snapshot.fallbackEventsTotal).toBe(1);
  });

  it("disconnect transitions store to inactive", () => {
    noteAgentEventStreamConnected();
    noteAgentEventStreamDisconnected();
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.redisUrlConfigured).toBe(1);
    expect(snapshot.redisStoreActive).toBe(0);
  });

  it("batch append metrics: counts batches and partial failures with sum/buckets", () => {
    noteAgentEventStreamBatchAppend(3);
    noteAgentEventStreamBatchAppend(7);
    noteAgentEventStreamBatchAppend(40);
    noteAgentEventStreamBatchPartialFailure(2);
    noteAgentEventStreamBatchPartialFailure(1);
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.batchAppendsTotal).toBe(3);
    expect(snapshot.batchPartialFailuresTotal).toBe(3);
    expect(snapshot.batchSize.count).toBe(3);
    expect(snapshot.batchSize.sum).toBe(50);
    /**
     * Buckets are cumulative. With sizes 3, 7, 40 the cumulative counts are:
     *   le=1 -> 0; le=2 -> 0; le=5 -> 1 (the "3"); le=10 -> 2 (3, 7);
     *   le=25 -> 2; le=50 -> 3 (3, 7, 40); le=100..5000 -> 3.
     */
    const find = (le: string): number =>
      snapshot.batchSize.buckets.find((b) => b.le === le)?.count ?? -1;
    expect(find("5")).toBe(1);
    expect(find("10")).toBe(2);
    expect(find("50")).toBe(3);
    expect(find("100")).toBe(3);
    // Generous profile: novos buckets ate 5000 cobrem fan-out de rooms grandes.
    expect(find("2000")).toBe(3);
    expect(find("5000")).toBe(3);
  });

  it("batch metrics ignore zero/negative invocations", () => {
    noteAgentEventStreamBatchAppend(0);
    noteAgentEventStreamBatchAppend(-2);
    noteAgentEventStreamBatchPartialFailure(0);
    noteAgentEventStreamBatchPartialFailure(-1);
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.batchAppendsTotal).toBe(0);
    expect(snapshot.batchPartialFailuresTotal).toBe(0);
    expect(snapshot.batchSize.count).toBe(0);
    expect(snapshot.batchSize.sum).toBe(0);
  });

  it("latency histogram stores observations per op", () => {
    observeAgentEventStreamLatency("append", 7);
    observeAgentEventStreamLatency("append", 30);
    observeAgentEventStreamLatency("read", 200);
    observeAgentEventStreamLatency("ack", 1);
    const snapshot = getAgentEventStreamMetricsSnapshot();
    expect(snapshot.latency.append.count).toBe(2);
    expect(snapshot.latency.read.count).toBe(1);
    expect(snapshot.latency.ack.count).toBe(1);
    expect(snapshot.latency.trim.count).toBe(0);
  });
});
