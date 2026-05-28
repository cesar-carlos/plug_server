/**
 * Helpers for attaching `meta.serverTimings` to outbound responses on the
 * `relay:rpc.response` and `agents:command_response` events.
 *
 * Opt-in is controlled by the consumer via `requestServerTimings: true` on the
 * request envelope. The hub mirrors the per-phase snapshot from the
 * `BridgeLatencyTraceSession` attached to the request so that consumers can
 * correlate end-to-end wall clock against hub-internal latency without parsing
 * Prometheus metrics or DB rows.
 *
 * Contract:
 * - All values are milliseconds, rounded to 3 decimals (same as DB persistence).
 * - Keys are stable hub-internal phase names. New phases may be added at minor
 *   versions; consumers MUST tolerate unknown keys.
 * - `schemaVersion` is mirrored from `BRIDGE_LATENCY_PHASES_SCHEMA_VERSION`.
 * - The envelope lives under the JSON-RPC `meta` field for relay responses
 *   (passthrough on the agent contract), and as a sibling top-level field on
 *   `agents:command_response` for ergonomic parsing on REST-style consumers.
 *
 * Security: only timing values are exposed. Never include `traceId`,
 * `agentSocketId`, internal queue identifiers, or any other field that could
 * leak operational topology. See `.cursor/rules/security.mdc`.
 */

import { isRecord } from "../../shared/utils/rpc_types";
import {
  BRIDGE_LATENCY_PHASES_SCHEMA_VERSION,
  type BridgeLatencyTraceSession,
} from "./bridge_latency_trace_builder";

export interface ServerTimingsEnvelope {
  readonly schemaVersion: typeof BRIDGE_LATENCY_PHASES_SCHEMA_VERSION;
  readonly phasesMs: Readonly<Record<string, number>>;
}

export const buildServerTimingsEnvelope = (
  trace: BridgeLatencyTraceSession,
): ServerTimingsEnvelope => ({
  schemaVersion: BRIDGE_LATENCY_PHASES_SCHEMA_VERSION,
  phasesMs: trace.getPhasesSnapshot(),
});

/**
 * Mutates `payload` to merge `meta.serverTimings = envelope`. Returns the same
 * `payload` reference for ergonomic chaining; callers may keep relying on the
 * original reference (e.g. when the payload was annotated by
 * `markRelayOutboundForceGzip`). When `payload` is not a JSON-RPC response
 * object the function is a no-op — array (batch) responses are handled by
 * {@link attachServerTimingsToBatchResponse}.
 */
export const attachServerTimingsToResponse = (
  payload: unknown,
  envelope: ServerTimingsEnvelope,
): unknown => {
  if (!isRecord(payload)) {
    return payload;
  }
  const existingMeta = isRecord(payload.meta) ? payload.meta : null;
  payload.meta = {
    ...(existingMeta ?? {}),
    serverTimings: envelope,
  };
  return payload;
};

/**
 * Batch variant for `agents:command_response`. Attaches the same envelope to
 * every item so each correlation id carries its timing snapshot independently;
 * downstream consumers that index by `id` do not need to reach into a sibling
 * structure. The per-item snapshot is intentionally the same — phase metrics
 * are scoped per dispatch, not per JSON-RPC item.
 */
export const attachServerTimingsToBatchResponse = (
  payload: unknown,
  envelope: ServerTimingsEnvelope,
): unknown => {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      attachServerTimingsToResponse(item, envelope);
    }
    return payload;
  }
  return attachServerTimingsToResponse(payload, envelope);
};
