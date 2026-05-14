export const bridgeParityMethods = [
  "agent.getHealth",
  "agent.getProfile",
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
