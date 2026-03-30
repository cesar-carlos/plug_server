import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueBridgeLatencyTrace = vi.fn();
const recordBridgeLatencyTracePersistSkipped = vi.fn();

vi.mock("../../../../src/application/services/bridge_latency_trace.service", () => ({
  enqueueBridgeLatencyTrace: (row: unknown) => enqueueBridgeLatencyTrace(row),
  recordBridgeLatencyTracePersistSkipped: () => recordBridgeLatencyTracePersistSkipped(),
}));

import {
  BridgeLatencyTraceSession,
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
  });
});
