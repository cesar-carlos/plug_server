import { env } from "../../../shared/config/env";
import {
  decodePayloadFrame,
  decodePayloadFrameAsync,
  encodePayloadFrameHotPath,
  isPayloadFrameEnvelope,
  type PayloadFrameEnvelope,
} from "../../../shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import { logger } from "../../../shared/utils/logger";

export const AGENTS_STREAM_PULL_LEGACY_COMPAT_REMOVE_AFTER = "2026-09-30";

const agentsStreamPullLegacyCompatRemovalInstant = (): number =>
  Date.parse(`${AGENTS_STREAM_PULL_LEGACY_COMPAT_REMOVE_AFTER}T23:59:59.999Z`);

/**
 * Boot warning when the documented removal date for `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE=raw_json`
 * has passed. Per `governance.mdc` exception tracking.
 */
export const warnIfAgentsStreamPullLegacyCompatExpired = (
  nowMs: number = Date.now(),
  compatMode: typeof env.socketAgentsStreamPullCompatMode = env.socketAgentsStreamPullCompatMode,
): void => {
  if (nowMs <= agentsStreamPullLegacyCompatRemovalInstant()) {
    return;
  }

  logger.warn("agents_stream_pull_legacy_compat_past_removal_date", {
    removeAfter: AGENTS_STREAM_PULL_LEGACY_COMPAT_REMOVE_AFTER,
    compatMode,
    remediation:
      "Delete raw_json compat in agents_stream_pull_wire.ts and remove SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE from env/docs.",
  });
};

export type AgentsStreamPullResponsePayload =
  | {
      success: true;
      requestId: string;
      streamId: string;
      windowSize: number;
      rateLimit?: {
        remainingCredits: number;
        limit: number;
        scope: "user" | "anon";
      };
    }
  | {
      success: false;
      error: { code: string; message: string; statusCode?: number; retryAfterMs?: number };
      rateLimit?: {
        remainingCredits: number;
        limit: number;
        scope: "user" | "anon";
      };
    };

export type DecodeAgentsStreamPullInboundResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * Inbound `/consumers` `agents:stream_pull` accepts plain JSON (legacy) and `PayloadFrame`
 * during the migration window. Outbound wire format is controlled separately by
 * `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE` (independent from `SOCKET_AGENTS_COMMAND_COMPAT_MODE`
 * so operators can migrate command and stream_pull on different schedules).
 */
export const decodeAgentsStreamPullInboundPayload = async (
  rawPayload: unknown,
): Promise<DecodeAgentsStreamPullInboundResult> => {
  if (isPayloadFrameEnvelope(rawPayload)) {
    const decoded = await decodePayloadFrameAsync(rawPayload);
    if (!decoded.ok) {
      return { ok: false, message: decoded.error.message };
    }
    if (!isRecord(decoded.value.data)) {
      return { ok: false, message: "agents:stream_pull PayloadFrame body must be an object" };
    }
    return { ok: true, data: decoded.value.data };
  }

  if (isRecord(rawPayload)) {
    return { ok: true, data: rawPayload };
  }

  return { ok: false, message: "agents:stream_pull payload must be an object or PayloadFrame" };
};

type AgentsStreamPullWireEncodeOptions = {
  readonly requestId?: string;
};

const resolveAgentsStreamPullRequestId = (
  payload: AgentsStreamPullResponsePayload,
  explicitRequestId?: string,
): string | undefined => {
  if (explicitRequestId !== undefined && explicitRequestId !== "") {
    return explicitRequestId;
  }
  if ("requestId" in payload && typeof payload.requestId === "string") {
    return payload.requestId;
  }
  return undefined;
};

/**
 * Hot-path encoder for high-frequency `agents:stream_pull_response` events (no gzip on the event loop).
 * Transitional compatibility shim: `raw_json` restores legacy outbound plain JSON only.
 */
export const buildAgentsStreamPullResponseForWire = (
  payload: AgentsStreamPullResponsePayload,
  options?: AgentsStreamPullWireEncodeOptions,
): AgentsStreamPullResponsePayload | PayloadFrameEnvelope => {
  if (env.socketAgentsStreamPullCompatMode === "raw_json") {
    return payload;
  }

  const requestId = resolveAgentsStreamPullRequestId(payload, options?.requestId);
  return encodePayloadFrameHotPath(payload, {
    ...(requestId !== undefined ? { requestId } : {}),
  });
};

/** Decode outbound wire payloads in tests and SDK helpers. */
export const decodeAgentsStreamPullWirePayload = <T>(rawPayload: unknown): T => {
  if (isPayloadFrameEnvelope(rawPayload)) {
    const decoded = decodePayloadFrame(rawPayload);
    if (!decoded.ok) {
      throw new Error(`Failed to decode agents:stream_pull wire payload: ${decoded.error.message}`);
    }
    if (!isRecord(decoded.value.data)) {
      throw new Error("agents:stream_pull wire payload body must be an object");
    }
    return decoded.value.data as T;
  }
  if (isRecord(rawPayload)) {
    return rawPayload as T;
  }
  throw new Error("agents:stream_pull wire payload must be an object or PayloadFrame");
};

/** Resolve requestId from inbound pull body for outbound correlation. */
export const extractAgentsStreamPullRequestId = (rawPayload: unknown): string | undefined => {
  if (!isRecord(rawPayload)) {
    return undefined;
  }
  const fromRequestId = toRequestId(rawPayload.requestId);
  if (fromRequestId) {
    return fromRequestId;
  }
  return toRequestId(rawPayload.request_id) ?? undefined;
};
