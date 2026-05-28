import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueBridgeLatencyTrace = vi.fn();
const recordBridgeLatencyTracePersistSkipped = vi.fn();

vi.mock("../../../../src/application/services/bridge_latency_trace.service", () => ({
  enqueueBridgeLatencyTrace: (row: unknown) => enqueueBridgeLatencyTrace(row),
  recordBridgeLatencyTracePersistSkipped: () => recordBridgeLatencyTracePersistSkipped(),
}));

import type * as EnvModule from "../../../../src/shared/config/env";

vi.mock("../../../../src/shared/config/env", async () => {
  const actual = await vi.importActual<typeof EnvModule>("../../../../src/shared/config/env");
  return {
    ...actual,
    env: {
      ...actual.env,
      bridgeLatencyTraceEnabled: false,
    },
  };
});

import {
  BridgeLatencyTraceSession,
  createBridgeLatencyTraceForRequest,
  createBridgeLatencyTraceIfSampled,
  inferBridgeCommandMethod,
} from "../../../../src/application/services/bridge_latency_trace_builder";

describe("bridge_latency_trace_builder", () => {
  beforeEach(() => {
    enqueueBridgeLatencyTrace.mockClear();
    recordBridgeLatencyTracePersistSkipped.mockClear();
  });

  describe("inferBridgeCommandMethod", () => {
    it("returns batch for JSON-RPC batch", () => {
      expect(
        inferBridgeCommandMethod([
          { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
        ] as never),
      ).toBe("batch");
    });

    it("returns method for single command", () => {
      expect(
        inferBridgeCommandMethod({
          jsonrpc: "2.0",
          method: "sql.execute",
          id: "1",
          params: {},
        } as never),
      ).toBe("sql.execute");
    });
  });

  describe("BridgeLatencyTraceSession", () => {
    beforeEach(() => {
      vi.spyOn(Math, "random").mockReturnValue(0);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not enqueue finalize without dispatch meta", () => {
      const s = new BridgeLatencyTraceSession("rest", "user-1");
      expect(s.finalizeOnce({ outcome: "success", httpStatus: 200 })).toBe(false);
      expect(enqueueBridgeLatencyTrace).not.toHaveBeenCalled();
    });

    it("enqueues once on finalize with meta and ignores second finalize", () => {
      const s = new BridgeLatencyTraceSession("consumer_socket", undefined);
      s.attachDispatchMeta({
        requestId: "req-1",
        traceId: "trace-1",
        jsonRpcMethod: "sql.execute",
        agentId: "agent-1",
      });
      s.addPhaseMs("transform_ms", 1.5);
      s.markEmitComplete(0.1, performance.now());
      expect(s.finalizeOnce({ outcome: "success", httpStatus: 200 })).toBe(true);
      expect(enqueueBridgeLatencyTrace).toHaveBeenCalledTimes(1);
      const row = enqueueBridgeLatencyTrace.mock.calls[0][0] as {
        phasesMs: Record<string, number>;
        phasesSumMs: number;
        phasesSchemaVersion: number;
        outcome: string;
        channel: string;
      };
      expect(row.outcome).toBe("success");
      expect(row.channel).toBe("consumer_socket");
      expect(row.phasesMs.transform_ms).toBe(1.5);
      expect(row.phasesSumMs).toBeGreaterThan(0);
      expect(row.phasesSchemaVersion).toBe(1);
      expect(s.finalizeOnce({ outcome: "error", httpStatus: 500 })).toBe(false);
      expect(enqueueBridgeLatencyTrace).toHaveBeenCalledTimes(1);
    });

    it("dismissWithoutPersist does not enqueue", () => {
      const s = new BridgeLatencyTraceSession("relay", undefined);
      s.attachDispatchMeta({
        requestId: "r",
        traceId: "t",
        jsonRpcMethod: "sql.execute",
        agentId: "a",
      });
      s.dismissWithoutPersist();
      expect(enqueueBridgeLatencyTrace).not.toHaveBeenCalled();
      expect(s.finalizeOnce({ outcome: "success" })).toBe(false);
    });

    it("records agent_to_hub_ms from markInboundArrival", () => {
      const s = new BridgeLatencyTraceSession("rest", undefined);
      s.attachDispatchMeta({
        requestId: "r",
        traceId: "t",
        jsonRpcMethod: "x",
        agentId: "a",
      });
      const emitEnd = performance.now();
      s.markEmitComplete(0.05, emitEnd);
      s.markInboundArrival(emitEnd + 12);
      s.finalizeOnce({ outcome: "success", httpStatus: 200 });
      const row = enqueueBridgeLatencyTrace.mock.calls[0][0] as {
        phasesMs: Record<string, number>;
      };
      expect(row.phasesMs.agent_to_hub_ms).toBeGreaterThanOrEqual(11);
      expect(row.phasesMs.agent_to_hub_ms).toBeLessThan(50);
    });

    it("caps the number of distinct phase keys to prevent unbounded growth", () => {
      const s = new BridgeLatencyTraceSession("relay", undefined);
      // Push more than the documented cap (64) to confirm overflow is dropped.
      for (let i = 0; i < 80; i += 1) {
        s.addPhaseMs(`phase_${i}`, i);
      }
      const snapshot = s.getPhasesSnapshot();
      expect(Object.keys(snapshot).length).toBeLessThanOrEqual(64);
      // Updates to existing keys still go through even after the cap.
      s.addPhaseMs("phase_0", 999);
      expect(s.getPhasesSnapshot().phase_0).toBe(999);
    });

    it("getPhasesSnapshot returns a defensive copy of the current phase map", () => {
      const s = new BridgeLatencyTraceSession("relay", undefined);
      s.addPhaseMs("encode_ms", 2.5);
      s.addPhaseMs("emit_to_socket_ms", 0.1);

      const snapshot = s.getPhasesSnapshot();
      expect(snapshot).toMatchObject({ encode_ms: 2.5, emit_to_socket_ms: 0.1 });

      (snapshot as Record<string, number>).encode_ms = 999;
      // Internal map must not be mutated by external writers.
      expect(s.getPhasesSnapshot().encode_ms).toBe(2.5);
    });
  });

  describe("createBridgeLatencyTraceForRequest", () => {
    // The mocked env above sets bridgeLatencyTraceEnabled = false so we can
    // assert both branches without depending on real env state.
    it("returns null when forceActive is false and global tracing is disabled", () => {
      expect(createBridgeLatencyTraceIfSampled({ channel: "relay", userId: "u" })).toBeNull();
      expect(
        createBridgeLatencyTraceForRequest({ channel: "relay", userId: "u", forceActive: false }),
      ).toBeNull();
    });

    it("returns an active session when forceActive is true even with global tracing disabled", () => {
      const session = createBridgeLatencyTraceForRequest({
        channel: "consumer_socket",
        userId: "u-1",
        forceActive: true,
      });
      expect(session).not.toBeNull();
      expect(session?.channel).toBe("consumer_socket");
      expect(session?.userId).toBe("u-1");
      expect(session?.isFinalized()).toBe(false);
    });
  });
});
