import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/application/services/bridge_latency_trace.service", () => ({
  enqueueBridgeLatencyTrace: vi.fn(),
  recordBridgeLatencyTracePersistSkipped: vi.fn(),
}));

import {
  BRIDGE_LATENCY_PHASES_SCHEMA_VERSION,
  BridgeLatencyTraceSession,
} from "../../../../src/application/services/bridge_latency_trace_builder";
import {
  attachServerTimingsToBatchResponse,
  attachServerTimingsToResponse,
  buildServerTimingsEnvelope,
} from "../../../../src/application/services/server_timings_envelope";

const makeTrace = (): BridgeLatencyTraceSession => {
  const trace = new BridgeLatencyTraceSession("relay", undefined);
  trace.addPhaseMs("encode_ms", 1.2);
  trace.addPhaseMs("emit_to_socket_ms", 0.1);
  return trace;
};

describe("server_timings_envelope", () => {
  describe("buildServerTimingsEnvelope", () => {
    it("returns the schema version alongside the recorded phases", () => {
      const trace = makeTrace();
      const envelope = buildServerTimingsEnvelope(trace);

      expect(envelope.schemaVersion).toBe(BRIDGE_LATENCY_PHASES_SCHEMA_VERSION);
      expect(envelope.phasesMs).toMatchObject({ encode_ms: 1.2, emit_to_socket_ms: 0.1 });
    });

    it("isolates the envelope from later mutations on the session", () => {
      const trace = makeTrace();
      const envelope = buildServerTimingsEnvelope(trace);
      trace.addPhaseMs("encode_ms", 9.9);

      expect(envelope.phasesMs.encode_ms).toBe(1.2);
    });
  });

  describe("attachServerTimingsToResponse", () => {
    it("merges meta.serverTimings into an existing object payload", () => {
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: "req-1",
        result: { value: 1 },
        meta: { existing: true },
      };
      const envelope = buildServerTimingsEnvelope(makeTrace());

      attachServerTimingsToResponse(payload, envelope);

      const meta = payload.meta as Record<string, unknown>;
      expect(meta.existing).toBe(true);
      expect(meta.serverTimings).toEqual(envelope);
    });

    it("creates the meta field when the payload had none", () => {
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: "req-1",
        result: { value: 1 },
      };
      const envelope = buildServerTimingsEnvelope(makeTrace());

      attachServerTimingsToResponse(payload, envelope);

      expect((payload.meta as Record<string, unknown>).serverTimings).toEqual(envelope);
    });

    it("is a no-op for non-object payloads", () => {
      const envelope = buildServerTimingsEnvelope(makeTrace());

      expect(attachServerTimingsToResponse(null, envelope)).toBe(null);
      expect(attachServerTimingsToResponse("string", envelope)).toBe("string");
      expect(attachServerTimingsToResponse(42, envelope)).toBe(42);
    });
  });

  describe("envelope size", () => {
    /**
     * Both protocol docs (`docs/socket_relay_protocol.md` and
     * `docs/api_rest_bridge.md`) promise ~120 bytes per response when the
     * consumer opts into `meta.serverTimings`. This test fails loudly if a
     * future change to phase names or serialization inflates the envelope
     * silently — the opt-in cost is the main reason consumers may decide
     * not to enable timings on high-throughput flows.
     */
    it("serializes to approximately ~120 bytes for a realistic relay snapshot", () => {
      const trace = new BridgeLatencyTraceSession("relay", undefined);
      // Representative set of phases populated during a hot relay path —
      // see `rpc_bridge_dispatch_relay.ts` and `rpc_bridge_agent_inbound.ts`.
      trace.addPhaseMs("consumer_frame_decode_ms", 0.42);
      trace.addPhaseMs("relay_preflight_ms", 0.13);
      trace.addPhaseMs("encode_ms", 0.85);
      trace.addPhaseMs("emit_to_socket_ms", 0.07);
      trace.addPhaseMs("agent_to_hub_ms", 142.1);
      trace.addPhaseMs("inbound_decode_ms", 0.41);
      trace.addPhaseMs("pending_resolve_ms", 0.18);
      trace.addPhaseMs("relay_forward_to_consumer_ms", 0.06);

      const envelope = buildServerTimingsEnvelope(trace);
      const serializedBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");

      // Documented budget: ~120 bytes. Allow a 50% headroom for new phases
      // before forcing a doc update. If this fails, either the snapshot
      // grew (intentional: update both protocol docs) or new fields were
      // added to the envelope shape (bump `BRIDGE_LATENCY_PHASES_SCHEMA_VERSION`).
      expect(serializedBytes).toBeGreaterThan(60);
      expect(serializedBytes).toBeLessThan(360);
    });
  });

  describe("attachServerTimingsToBatchResponse", () => {
    it("attaches the envelope to every JSON-RPC item in a batch response", () => {
      const payload: Array<Record<string, unknown>> = [
        { jsonrpc: "2.0", id: "r1", result: { ok: 1 } },
        { jsonrpc: "2.0", id: "r2", result: { ok: 2 } },
      ];
      const envelope = buildServerTimingsEnvelope(makeTrace());

      attachServerTimingsToBatchResponse(payload, envelope);

      for (const item of payload) {
        expect((item.meta as Record<string, unknown>).serverTimings).toEqual(envelope);
      }
    });

    it("falls back to single-response attachment for non-array payloads", () => {
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: "r1",
        result: {},
      };
      const envelope = buildServerTimingsEnvelope(makeTrace());

      attachServerTimingsToBatchResponse(payload, envelope);

      expect((payload.meta as Record<string, unknown>).serverTimings).toEqual(envelope);
    });
  });
});
