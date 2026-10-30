import { isRecord } from "../utils/rpc_types";
export const ACTION_IO_TRANSPORT = {
  version: 1,
  max_block_bytes: 65536,
  max_read_bytes: 262144,
  max_page_events: 256,
  max_json_bytes: 524288,
  max_execution_bytes: 67108864,
  max_queued_messages: 16,
  max_queued_bytes: 1048576,
  max_execution_messages: 8192,
  max_execution_events: 65536,
  max_wait_ms: 20000,
  request_timeout_ms: 30000,
  output_retention_seconds: 86400,
  deduplication_retention_seconds: 259200,
  max_readers_per_execution: 1,
  max_readers_per_client: 8,
  max_readers_per_connection: 16,
  max_readers_per_agent: 32,
  supports_interactive_input: true,
  requires_local_credential: true,
  automatic_replay: false,
} as const;

/** Fixed v1 agreement: incompatible peers cannot silently reduce guarantees. */
export const supportsActionIo = (raw: unknown): boolean => {
  if (!isRecord(raw) || Array.isArray(raw)) return false;
  const entries = Object.entries(ACTION_IO_TRANSPORT);
  return (
    Object.keys(raw).length === entries.length &&
    entries.every(([key, value]) => raw[key] === value)
  );
};
