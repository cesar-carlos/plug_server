/**
 * Single source of truth for hub-advertised transport contract.
 * Keep these values aligned with plug_agente docs and runtime enforcement.
 */

import { env } from "../config/env";

export const HUB_TRANSPORT_PROTOCOLS = ["jsonrpc-v2"] as const;
export const HUB_TRANSPORT_ENCODINGS = ["json"] as const;
export const HUB_TRANSPORT_COMPRESSIONS = ["gzip", "none"] as const;

export const HUB_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const HUB_MAX_COMPRESSED_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const HUB_MAX_DECODED_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES = 4096;
export const HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO = 10;

/**
 * Max rows accepted by bridge validators and advertised by hub capabilities.
 *
 * NOTE: plug_agente default is 50_000 (`max_rows` in `socket_communication_standard.md` →
 * "Limites do agente"). Hub advertises a higher ceiling so bigger streaming clients are
 * not blocked at the hub layer; `TransportLimits.negotiateWith` always settles on the
 * minimum between hub and agent, so the effective cap stays at whatever the connected
 * agent advertises (`resolveDispatchPolicy` clamps to this value as upper bound).
 *
 * If product policy changes, update this constant and keep tests/docs aligned.
 */
export const HUB_MAX_ROWS = 1_000_000;
export const HUB_MAX_BATCH_SIZE = 32;

/**
 * Stream numbers are currently advertised as conservative interoperability limits.
 * Runtime may still apply additional operational guards via env-based capacities.
 */
export const HUB_MAX_CONCURRENT_STREAMS = 1;
export const HUB_STREAMING_CHUNK_SIZE = 500;
export const HUB_STREAMING_ROW_THRESHOLD = 500;

export const HUB_TRANSPORT_EXTENSIONS = {
  batchSupport: true,
  binaryPayload: true,
  compressionThreshold: HUB_PAYLOAD_FRAME_COMPRESSION_THRESHOLD_BYTES,
  /** Aligned with plug_agente OutboundCompressionMode.auto: gzip only when smaller than raw UTF-8. */
  outboundCompressionMode: "auto",
  /** Optional explicit handshake completion sent by newer agents through `agent:ready`. */
  protocolReadyAck: true,
  maxInflationRatio: HUB_PAYLOAD_FRAME_MAX_INFLATION_RATIO,
  signatureRequired: false,
  signatureScope: "transport-frame",
  /** Aligned with plug_agente capabilities example (`hmac-sha256` transport-frame signing). */
  signatureAlgorithms: ["hmac-sha256"] as const,
  streamingResults: true,
  /**
   * Aligned with plug_agente OpenRPC `info.version` 2.11.2 (major/minor profile `2.11`:
   * agent actions plus health/bulk insert remain in the published contract). Bump in
   * lockstep with the agent profile.
   */
  plugProfile: "plug-jsonrpc-profile/2.11",
  orderedBatchResponses: true,
  notificationNullIdCompatibility: true,
  paginationModes: ["page-offset", "cursor-keyset"] as const,
  traceContext: ["w3c-trace-context", "legacy-trace-id"] as const,
  errorFormat: "structured-error-data",
  transportFrame: "payload-frame/1.0",
} as const;

/**
 * Default Plug RPC contract version injected by the hub when callers omit
 * `api_version` in bridge requests. Keep this aligned with the advertised
 * `plugProfile` minor version so hub-originated requests stay on the same
 * published contract as `agent:capabilities`.
 */
export const HUB_DEFAULT_API_VERSION = HUB_TRANSPORT_EXTENSIONS.plugProfile.replace(
  "plug-jsonrpc-profile/",
  "",
);

export const HUB_TRANSPORT_LIMITS = {
  max_payload_bytes: HUB_MAX_PAYLOAD_BYTES,
  max_compressed_payload_bytes: HUB_MAX_COMPRESSED_PAYLOAD_BYTES,
  max_decoded_payload_bytes: HUB_MAX_DECODED_PAYLOAD_BYTES,
  max_rows: HUB_MAX_ROWS,
  max_batch_size: HUB_MAX_BATCH_SIZE,
  max_concurrent_streams: HUB_MAX_CONCURRENT_STREAMS,
  streaming_chunk_size: HUB_STREAMING_CHUNK_SIZE,
  streaming_row_threshold: HUB_STREAMING_ROW_THRESHOLD,
} as const;

export const HUB_SERVER_CAPABILITIES = {
  protocols: HUB_TRANSPORT_PROTOCOLS,
  encodings: HUB_TRANSPORT_ENCODINGS,
  compressions: HUB_TRANSPORT_COMPRESSIONS,
  extensions: HUB_TRANSPORT_EXTENSIONS,
  limits: HUB_TRANSPORT_LIMITS,
} as const;

export interface HubStreamPullWindowHints {
  /** REST bridge default window size; advertised so agents can calibrate `rpc:stream.pull`. */
  readonly recommendedStreamPullWindowSize: number;
  /** Upper bound the hub is willing to consume (matches the env-configured cap). */
  readonly maxStreamPullWindowSize: number;
}

/**
 * Build the capabilities payload sent inside `agent:capabilities` after `agent:register`.
 * Includes optional stream-pull window hints (per `socket_communication_standard.md`
 * "Streaming chunked"/`extensions.recommendedStreamPullWindowSize`) when provided, so
 * agents can calibrate `rpc:stream.pull` window sizing without re-discovering it.
 */
export const buildHubServerCapabilities = (
  hints?: HubStreamPullWindowHints,
): {
  readonly protocols: typeof HUB_TRANSPORT_PROTOCOLS;
  readonly encodings: typeof HUB_TRANSPORT_ENCODINGS;
  readonly compressions: typeof HUB_TRANSPORT_COMPRESSIONS;
  readonly extensions: Record<string, unknown>;
  readonly limits: typeof HUB_TRANSPORT_LIMITS;
} => {
  const extensions: Record<string, unknown> = { ...HUB_TRANSPORT_EXTENSIONS };
  if (!env.payloadSigningKey || env.payloadSigningKey.trim() === "") {
    extensions.signatureAlgorithms = [];
  }
  if (hints) {
    const maxStreamPullWindowSize = Math.max(1, Math.floor(hints.maxStreamPullWindowSize));
    const recommendedStreamPullWindowSize = Math.min(
      maxStreamPullWindowSize,
      Math.max(1, Math.floor(hints.recommendedStreamPullWindowSize)),
    );
    extensions.recommendedStreamPullWindowSize = recommendedStreamPullWindowSize;
    extensions.maxStreamPullWindowSize = maxStreamPullWindowSize;
  }
  return {
    protocols: HUB_TRANSPORT_PROTOCOLS,
    encodings: HUB_TRANSPORT_ENCODINGS,
    compressions: HUB_TRANSPORT_COMPRESSIONS,
    extensions,
    limits: HUB_TRANSPORT_LIMITS,
  };
};
