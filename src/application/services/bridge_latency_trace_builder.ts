import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";

import { env } from "../../shared/config/env";
import type { BridgeCommand } from "../../shared/validators/agent_command";
import {
  bridgeLatencySpanAddEvent,
  endBridgeLatencySpan,
  startBridgeLatencySpan,
} from "../../shared/utils/bridge_latency_trace_otel";

import {
  enqueueBridgeLatencyTrace,
  recordBridgeLatencyTracePersistSkipped,
} from "./bridge_latency_trace.service";

export const BRIDGE_LATENCY_PHASES_SCHEMA_VERSION = 1;

export type BridgeLatencyChannel = "rest" | "consumer_socket" | "relay";

export type BridgeLatencyOutcome = "success" | "notification" | "error" | "timeout" | "abort";

export interface BridgeLatencyTraceFinalizeInput {
  readonly outcome: BridgeLatencyOutcome;
  readonly httpStatus?: number;
  readonly errorCode?: string;
}

const roundMs = (n: number): number => Math.max(0, Math.round(n * 1000) / 1000);

const sumPhaseValues = (phases: Record<string, number>): number => {
  let sum = 0;
  for (const v of Object.values(phases)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
    }
  }
  return roundMs(sum);
};

const shouldPersistRow = (input: BridgeLatencyTraceFinalizeInput, totalMs: number): boolean => {
  if (Math.random() * 100 < env.bridgeLatencyTraceSamplePercent) {
    return true;
  }
  if (input.outcome === "error" || input.outcome === "timeout" || input.outcome === "abort") {
    return true;
  }
  const slow = env.bridgeLatencyTraceSlowTotalMs;
  if (slow > 0 && totalMs >= slow) {
    return true;
  }
  return false;
};

export const inferBridgeCommandMethod = (command: BridgeCommand): string => {
  if (Array.isArray(command)) {
    return "batch";
  }
  if (typeof command === "object" && command !== null && "method" in command) {
    const m = (command as { method?: unknown }).method;
    return typeof m === "string" && m.length > 0 ? m : "unknown";
  }
  return "unknown";
};

export interface BridgeLatencyDispatchMeta {
  readonly requestId: string;
  readonly traceId: string;
  readonly jsonRpcMethod: string;
  readonly agentId: string;
}

/**
 * Collects per-phase durations for one hub↔agent bridge command; enqueues one DB row on finalize when sampling allows.
 */
export class BridgeLatencyTraceSession {
  readonly id = randomUUID();
  private readonly wallStartMs = Date.now();
  private readonly phases: Record<string, number> = {};
  private finalized = false;
  private emitFinishedPerf: number | null = null;
  private decodeEndedPerf: number | null = null;
  private meta: BridgeLatencyDispatchMeta | null = null;
  private relayStreamOpenWallMs: number | null = null;
  private readonly otelSpan: Span | null;

  constructor(
    readonly channel: BridgeLatencyChannel,
    readonly userId: string | undefined,
  ) {
    this.otelSpan = startBridgeLatencySpan(channel);
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  hasDispatchMeta(): boolean {
    return this.meta !== null;
  }

  /** Skip DB row (e.g. relay deduplicated replay). */
  dismissWithoutPersist(): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    endBridgeLatencySpan(this.otelSpan, "dismissed");
  }

  attachDispatchMeta(input: BridgeLatencyDispatchMeta): void {
    if (this.finalized) {
      return;
    }
    this.meta = input;
    if (this.otelSpan) {
      this.otelSpan.setAttribute("bridge.request_id", input.requestId);
      this.otelSpan.setAttribute("bridge.agent_id", input.agentId);
    }
  }

  addPhaseMs(phase: string, ms: number): void {
    if (this.finalized) {
      return;
    }
    this.phases[phase] = roundMs(ms);
  }

  markEmitComplete(emitMs: number, emitEndedAtPerf: number): void {
    if (this.finalized) {
      return;
    }
    this.phases.emit_to_socket_ms = roundMs(emitMs);
    this.emitFinishedPerf = emitEndedAtPerf;
    bridgeLatencySpanAddEvent(this.otelSpan, "emit_complete");
  }

  /**
   * `arrivalPerf` = `performance.now()` at synchronous entry of `rpc:response` (before async decode).
   */
  markInboundArrival(arrivalPerf: number): void {
    if (this.finalized || this.emitFinishedPerf === null) {
      return;
    }
    this.phases.agent_to_hub_ms = roundMs(arrivalPerf - this.emitFinishedPerf);
  }

  recordInboundDecodeMs(ms: number): void {
    if (this.finalized) {
      return;
    }
    this.phases.inbound_decode_ms = roundMs(ms);
    this.decodeEndedPerf = performance.now();
  }

  recordPendingResolveEnd(): void {
    if (this.finalized || this.decodeEndedPerf === null) {
      return;
    }
    this.phases.pending_resolve_ms = roundMs(performance.now() - this.decodeEndedPerf);
    this.decodeEndedPerf = null;
  }

  /** Relay: first agent response opened a stream; wall-clock tail until `finalizeRelayStreamComplete`. */
  markRelayStreamOpenWall(): void {
    if (this.finalized) {
      return;
    }
    if (this.relayStreamOpenWallMs === null) {
      this.relayStreamOpenWallMs = Date.now();
    }
    this.decodeEndedPerf = null;
  }

  /** Call from relay stream teardown when `relay:rpc.complete` was forwarded. */
  finalizeRelayStreamComplete(): void {
    if (this.finalized || !this.meta) {
      return;
    }
    if (this.relayStreamOpenWallMs !== null) {
      this.addPhaseMs("relay_stream_duration_ms", Date.now() - this.relayStreamOpenWallMs);
    }
    this.finalizeOnceInternal({ outcome: "success" });
  }

  /**
   * Persists the trace row when sampling rules allow. Returns false if already finalized or dispatch meta was never attached.
   */
  finalizeOnce(input: BridgeLatencyTraceFinalizeInput): boolean {
    if (this.finalized || !this.meta) {
      return false;
    }
    this.finalizeOnceInternal(input);
    return true;
  }

  private finalizeOnceInternal(input: BridgeLatencyTraceFinalizeInput): void {
    if (this.finalized) {
      return;
    }
    this.finalized = true;

    const totalMs = Math.max(0, Date.now() - this.wallStartMs);
    const phasesMs = { ...this.phases };
    const phasesSumMs = Math.round(sumPhaseValues(phasesMs));

    const persist = shouldPersistRow(input, totalMs);
    if (persist) {
      enqueueBridgeLatencyTrace({
        id: this.id,
        channel: this.channel,
        requestId: this.meta!.requestId,
        traceId: this.meta!.traceId,
        agentId: this.meta!.agentId,
        userId: this.userId ?? null,
        jsonRpcMethod: this.meta!.jsonRpcMethod,
        totalMs,
        phasesSumMs,
        phasesSchemaVersion: BRIDGE_LATENCY_PHASES_SCHEMA_VERSION,
        phasesMs,
        outcome: input.outcome,
        httpStatus: input.httpStatus ?? null,
        errorCode: input.errorCode ?? null,
      });
    } else {
      recordBridgeLatencyTracePersistSkipped();
    }

    endBridgeLatencySpan(this.otelSpan, input.outcome, {
      total_ms: totalMs,
      persisted: persist ? 1 : 0,
      phases_sum_ms: phasesSumMs,
    });
  }
}

export const createBridgeLatencyTraceIfSampled = (input: {
  readonly channel: BridgeLatencyChannel;
  readonly userId: string | undefined;
}): BridgeLatencyTraceSession | null => {
  if (!env.bridgeLatencyTraceEnabled) {
    return null;
  }
  return new BridgeLatencyTraceSession(input.channel, input.userId);
};
