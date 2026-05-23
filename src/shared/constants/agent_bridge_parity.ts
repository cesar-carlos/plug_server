export const bridgeParityMethods = [
  "agent.getHealth",
  "agent.getProfile",
  "agent.action.run",
  "agent.action.validateRun",
  "agent.action.cancel",
  "agent.action.getExecution",
  "client_token.getPolicy",
  "rpc.discover",
  "sql.bulkInsert",
  "sql.cancel",
  "sql.execute",
  "sql.executeBatch",
] as const;

export type BridgeParityMethod = (typeof bridgeParityMethods)[number];

export type BridgeParityChannel = "rest" | "agentsCommand" | "relay";

export interface BridgeParityMethodRow {
  readonly method: BridgeParityMethod;
  readonly rest: true;
  readonly agentsCommand: true;
  readonly relay: true;
}

export const bridgeParityMethodRows: readonly BridgeParityMethodRow[] = bridgeParityMethods.map(
  (method) => ({
    method,
    rest: true,
    agentsCommand: true,
    relay: true,
  }),
);

export interface BridgeParityFeatureRow {
  readonly feature:
    | "json_rpc_batch"
    | "json_rpc_notification"
    | "timeout_ms"
    | "pagination_body"
    | "payload_frame_compression"
    | "progressive_streaming"
    | "strong_client_retry_idempotency";
  readonly rest: boolean;
  readonly agentsCommand: boolean;
  readonly relay: boolean;
  readonly note: string;
}

export const bridgeParityFeatureRows: readonly BridgeParityFeatureRow[] = [
  {
    feature: "json_rpc_batch",
    rest: true,
    agentsCommand: true,
    relay: false,
    note: "relay:rpc.request accepts one correlatable JSON-RPC request per frame",
  },
  {
    feature: "json_rpc_notification",
    rest: true,
    agentsCommand: true,
    relay: false,
    note: "relay requires a JSON-RPC id for timeout, routing and idempotency",
  },
  {
    feature: "timeout_ms",
    rest: true,
    agentsCommand: true,
    relay: true,
    note: "relay uses the per-request relay timeout instead of the REST body timeoutMs field",
  },
  {
    feature: "pagination_body",
    rest: true,
    agentsCommand: true,
    relay: false,
    note: "relay clients should send pagination through JSON-RPC params/options",
  },
  {
    feature: "payload_frame_compression",
    rest: true,
    agentsCommand: true,
    relay: true,
    note: "REST and agents:command use body payloadFrameCompression; relay uses the relay envelope field",
  },
  {
    feature: "progressive_streaming",
    rest: false,
    agentsCommand: true,
    relay: true,
    note: "REST materializes agent streams before returning a single HTTP response",
  },
  {
    feature: "strong_client_retry_idempotency",
    rest: false,
    agentsCommand: false,
    relay: true,
    note: "relay deduplicates client_request_id per conversation",
  },
] as const;

export const bridgeSocketRestApiParityScope = {
  duplicatesFullRestApi: false,
  socketScope: "agent_command_bridge",
  restOwns: ["bootstrap", "auth", "catalog", "crud_admin", "health", "metrics"],
} as const;

/**
 * `agents:command` wire migration on `/consumers` (legacy plain-JSON → `PayloadFrame`).
 *
 * Outbound default is `PayloadFrame` (`agents:command_response`, `agents:command_stream_*`).
 * Inbound accepts both plain JSON and `PayloadFrame` during the transition window.
 * `SOCKET_AGENTS_COMMAND_COMPAT_MODE=raw_json` restores legacy outbound plain JSON only.
 *
 * Per `websocket_api.mdc`: document legacy shapes that deviate from `PayloadFrame`.
 * Per `governance.mdc`: local, named exception with reason and removal condition.
 */
export const agentsCommandWireMigration = {
  inboundEvent: "agents:command",
  responseEvent: "agents:command_response",
  streamEvents: ["agents:command_stream_chunk", "agents:command_stream_complete"] as const,
  defaultOutboundWireFormat: "payload_frame" as const,
  compatModeEnv: "SOCKET_AGENTS_COMMAND_COMPAT_MODE",
  compatModes: ["payload_frame", "raw_json"] as const,
  inboundAcceptsDuringTransition: ["payload_frame", "plain_json"] as const,
  legacyCompatRemoveAfter: "2026-09-30" as const,
  reason:
    "Pre-dates PayloadFrame on /consumers; mirrors REST JSON bodies and legacy Colmeia SDK integrations.",
  removeWhen:
    "All production /consumers clients decode PayloadFrame on agents:command_response and stream events, inbound plain JSON is no longer observed, and SOCKET_AGENTS_COMMAND_COMPAT_MODE=raw_json is unused — or clients migrate to relay:rpc.request.",
} as const;

/** @deprecated Prefer {@link agentsCommandWireMigration}. Kept for existing contract tests and docs. */
export const agentsCommandPlainJsonWireException = agentsCommandWireMigration;

/**
 * `agents:stream_pull` wire migration on `/consumers` (legacy plain-JSON → `PayloadFrame`).
 *
 * Outbound default is `PayloadFrame` (`agents:stream_pull_response`) via hot-path encode.
 * Inbound accepts both plain JSON and `PayloadFrame` during the transition window.
 * `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE=raw_json` restores legacy outbound plain JSON only.
 * Uses a separate compat env from `agents:command` so operators can migrate each path independently.
 *
 * Per `websocket_api.mdc`: document legacy shapes that deviate from `PayloadFrame`.
 * Per `governance.mdc`: local, named exception with reason and removal condition.
 */
export const agentsStreamPullWireMigration = {
  inboundEvent: "agents:stream_pull",
  responseEvent: "agents:stream_pull_response",
  streamEvents: [] as const,
  defaultOutboundWireFormat: "payload_frame" as const,
  compatModeEnv: "SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE",
  compatModes: ["payload_frame", "raw_json"] as const,
  inboundAcceptsDuringTransition: ["payload_frame", "plain_json"] as const,
  legacyCompatRemoveAfter: "2026-09-30" as const,
  reason:
    "Pre-dates PayloadFrame on /consumers; last high-frequency legacy plain-JSON consumer path after agents:command migration.",
  removeWhen:
    "All production /consumers clients decode PayloadFrame on agents:stream_pull_response, inbound plain JSON is no longer observed, and SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE=raw_json is unused — or clients migrate to relay:rpc.stream.pull.",
} as const;

/** @deprecated Prefer {@link agentsStreamPullWireMigration}. Kept for existing contract tests and docs. */
export const agentsStreamPullPlainJsonWireException = agentsStreamPullWireMigration;
