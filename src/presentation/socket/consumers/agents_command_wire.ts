import type { ServerTimingsEnvelope } from "../../../application/services/server_timings_envelope";
import { env } from "../../../shared/config/env";
import type { PayloadFrameCompressionPreference } from "../../../shared/utils/payload_frame";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  encodePayloadFrameHotPath,
  isPayloadFrameEnvelope,
  payloadFrameEncodeOptionsFromPreference,
  type PayloadFrameEnvelope,
} from "../../../shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import { logger } from "../../../shared/utils/logger";

export const AGENTS_COMMAND_LEGACY_COMPAT_REMOVE_AFTER = "2026-09-30";

const agentsCommandLegacyCompatRemovalInstant = (): number =>
  Date.parse(`${AGENTS_COMMAND_LEGACY_COMPAT_REMOVE_AFTER}T23:59:59.999Z`);

/**
 * Boot warning when the documented removal date for `SOCKET_AGENTS_COMMAND_COMPAT_MODE=raw_json`
 * has passed. Per `governance.mdc` exception tracking.
 */
export const warnIfAgentsCommandLegacyCompatExpired = (
  nowMs: number = Date.now(),
  compatMode: typeof env.socketAgentsCommandCompatMode = env.socketAgentsCommandCompatMode,
): void => {
  if (nowMs <= agentsCommandLegacyCompatRemovalInstant()) {
    return;
  }

  logger.warn("agents_command_legacy_compat_past_removal_date", {
    removeAfter: AGENTS_COMMAND_LEGACY_COMPAT_REMOVE_AFTER,
    compatMode,
    remediation:
      "Delete raw_json compat in agents_command_wire.ts and remove SOCKET_AGENTS_COMMAND_COMPAT_MODE from env/docs.",
  });
};

export type AgentsCommandResponsePayload =
  | {
      success: true;
      requestId: string;
      response: unknown;
      streamId?: string;
      retryAfterSeconds?: number;
      /**
       * Opt-in per-phase latency snapshot. Present only when the consumer
       * sent `requestServerTimings: true` on the request body. See
       * `application/services/server_timings_envelope.ts`.
       */
      serverTimings?: ServerTimingsEnvelope;
    }
  | {
      success: false;
      requestId?: string;
      error: {
        code: string;
        message: string;
        statusCode?: number;
        retryAfterMs?: number;
      };
      /** Opt-in per-phase latency snapshot — emitted on failure when available. */
      serverTimings?: ServerTimingsEnvelope;
    };

export type DecodeAgentsCommandInboundResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * Inbound `/consumers` `agents:command` accepts plain JSON (legacy) and `PayloadFrame`
 * during the migration window. Outbound wire format is controlled separately by
 * `SOCKET_AGENTS_COMMAND_COMPAT_MODE`.
 */
export const decodeAgentsCommandInboundPayload = (
  rawPayload: unknown,
): DecodeAgentsCommandInboundResult => {
  if (isPayloadFrameEnvelope(rawPayload)) {
    const decoded = decodePayloadFrame(rawPayload);
    if (!decoded.ok) {
      return { ok: false, message: decoded.error.message };
    }
    if (!isRecord(decoded.value.data)) {
      return { ok: false, message: "agents:command PayloadFrame body must be an object" };
    }
    return { ok: true, data: decoded.value.data };
  }

  if (isRecord(rawPayload)) {
    return { ok: true, data: rawPayload };
  }

  return { ok: false, message: "agents:command payload must be an object or PayloadFrame" };
};

type AgentsCommandWireEncodeOptions = {
  readonly requestId?: string;
  readonly payloadFrameCompression?: PayloadFrameCompressionPreference;
};

const resolveAgentsCommandRequestId = (
  payload: Record<string, unknown>,
  explicitRequestId?: string,
): string | undefined => {
  if (explicitRequestId !== undefined && explicitRequestId !== "") {
    return explicitRequestId;
  }
  const fromPayload = toRequestId(payload.request_id);
  return fromPayload ?? undefined;
};

/**
 * Transitional compatibility shim for outbound `agents:command_response`.
 * Default/current mode is `PayloadFrame`; `raw_json` exists only for narrow, time-boxed migrations.
 */
export const buildAgentsCommandResponseForWire = (
  payload: AgentsCommandResponsePayload,
  options?: AgentsCommandWireEncodeOptions,
): AgentsCommandResponsePayload | PayloadFrameEnvelope => {
  if (env.socketAgentsCommandCompatMode === "raw_json") {
    return payload;
  }

  const requestId =
    options?.requestId ??
    ("requestId" in payload && typeof payload.requestId === "string"
      ? payload.requestId
      : undefined);

  return encodePayloadFrame(payload, {
    ...payloadFrameEncodeOptionsFromPreference(options?.payloadFrameCompression),
    ...(requestId !== undefined ? { requestId } : {}),
    omitTraceId: true,
  });
};

/** Hot-path encoder for high-frequency stream events (no gzip on the event loop). */
export const buildAgentsCommandStreamEventForWire = (
  payload: Record<string, unknown>,
  options?: Pick<AgentsCommandWireEncodeOptions, "requestId">,
): Record<string, unknown> | PayloadFrameEnvelope => {
  if (env.socketAgentsCommandCompatMode === "raw_json") {
    return payload;
  }

  const requestId = resolveAgentsCommandRequestId(payload, options?.requestId);
  return encodePayloadFrameHotPath(payload, {
    ...(requestId !== undefined ? { requestId } : {}),
  });
};
