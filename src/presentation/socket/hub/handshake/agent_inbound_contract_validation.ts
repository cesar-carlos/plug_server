import { env } from "../../../../shared/config/env";
import { HUB_MAX_BATCH_SIZE } from "../../../../shared/constants/agent_transport_contract";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { noteAgentInboundContractValidationFailed } from "../../../../shared/metrics/socket_agent.metrics";
import { logger } from "../../../../shared/utils/logger";
import { isRecord } from "../../../../shared/utils/rpc_types";

type AgentInboundContractEvent =
  | typeof socketEvents.rpcBatchAck
  | typeof socketEvents.rpcChunk
  | typeof socketEvents.rpcComplete
  | typeof socketEvents.rpcRequestAck
  | typeof socketEvents.rpcResponse;

type ContractValidationMode = "strict" | "warn" | "off";

interface ContractValidationFailure {
  readonly message: string;
}

interface AgentInboundContractValidationInput {
  readonly eventName: AgentInboundContractEvent;
  readonly payload: unknown;
  readonly socketId: string;
}

export type AgentInboundContractValidationResult =
  | { readonly ok: true; readonly shouldProcess: true }
  | { readonly ok: false; readonly shouldProcess: boolean; readonly message: string };

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isStringOrNumber = (value: unknown): boolean =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0;

const reject = (message: string): ContractValidationFailure => ({ message });

const ensureOnlyKeys = (
  payload: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): ContractValidationFailure | null => {
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      return reject(`unexpected property ${key}`);
    }
  }
  return null;
};

const validateRpcMeta = (meta: unknown): ContractValidationFailure | null => {
  if (!isRecord(meta)) {
    return reject("meta must be an object");
  }
  const allowedKeys = new Set([
    "trace_id",
    "traceparent",
    "tracestate",
    "request_id",
    "agent_id",
    "timestamp",
  ]);
  const extraKey = ensureOnlyKeys(meta, allowedKeys);
  if (extraKey !== null) {
    return reject(`meta.${extraKey.message}`);
  }
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value !== "string") {
      return reject(`meta.${key} must be a string`);
    }
  }
  return null;
};

const validateRpcResponseError = (error: Record<string, unknown>): ContractValidationFailure | null => {
  if (typeof error.code !== "number" || !Number.isInteger(error.code)) {
    return reject("rpc:response error.code must be an integer");
  }
  if (typeof error.message !== "string") {
    return reject("rpc:response error.message must be a string");
  }
  if (error.data !== undefined && !isRecord(error.data)) {
    return reject("rpc:response error.data must be an object");
  }
  return null;
};

const validateRpcResponseObject = (payload: unknown): ContractValidationFailure | null => {
  if (!isRecord(payload)) {
    return reject("rpc:response item must be an object");
  }
  if (payload.jsonrpc !== "2.0") {
    return reject("rpc:response jsonrpc must be 2.0");
  }
  if (!hasOwn(payload, "id")) {
    return reject("rpc:response id is required");
  }
  const hasResult = hasOwn(payload, "result");
  const hasError = hasOwn(payload, "error");
  if (hasResult === hasError) {
    return reject("rpc:response must contain exactly one of result or error");
  }
  if (hasResult && !isRecord(payload.result)) {
    return reject("rpc:response result must be an object");
  }
  if (hasError && !isRecord(payload.error)) {
    return reject("rpc:response error must be an object");
  }
  if (hasError && isRecord(payload.error)) {
    const errorValidation = validateRpcResponseError(payload.error);
    if (errorValidation !== null) {
      return errorValidation;
    }
  }
  if (payload.api_version !== undefined && typeof payload.api_version !== "string") {
    return reject("rpc:response api_version must be a string");
  }
  if (payload.meta !== undefined) {
    const metaValidation = validateRpcMeta(payload.meta);
    if (metaValidation !== null) {
      return metaValidation;
    }
  }
  return null;
};

const validateRpcResponse = (payload: unknown): ContractValidationFailure | null => {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return reject("rpc:response batch must contain at least one item");
    }
    if (payload.length > HUB_MAX_BATCH_SIZE) {
      return reject(`rpc:response batch cannot exceed ${HUB_MAX_BATCH_SIZE}`);
    }
    for (const item of payload) {
      const itemValidation = validateRpcResponseObject(item);
      if (itemValidation !== null) {
        return itemValidation;
      }
    }
    return null;
  }
  return validateRpcResponseObject(payload);
};

const validateRecordArray = (
  value: unknown,
  fieldName: string,
): ContractValidationFailure | null => {
  if (!Array.isArray(value)) {
    return reject(`${fieldName} must be an array`);
  }
  for (const item of value) {
    if (!isRecord(item)) {
      return reject(`${fieldName} items must be objects`);
    }
  }
  return null;
};

const validateRpcChunk = (payload: unknown): ContractValidationFailure | null => {
  if (!isRecord(payload)) {
    return reject("rpc:chunk payload must be an object");
  }
  const extraKey = ensureOnlyKeys(
    payload,
    new Set(["stream_id", "request_id", "chunk_index", "rows", "total_chunks", "column_metadata"]),
  );
  if (extraKey !== null) {
    return extraKey;
  }
  if (typeof payload.stream_id !== "string" || payload.stream_id.trim() === "") {
    return reject("rpc:chunk stream_id is required");
  }
  if (!isStringOrNumber(payload.request_id)) {
    return reject("rpc:chunk request_id must be a string or number");
  }
  if (!isNonNegativeInteger(payload.chunk_index)) {
    return reject("rpc:chunk chunk_index must be a non-negative integer");
  }
  const rowsValidation = validateRecordArray(payload.rows, "rpc:chunk rows");
  if (rowsValidation !== null) {
    return rowsValidation;
  }
  if (payload.total_chunks !== undefined && !isPositiveInteger(payload.total_chunks)) {
    return reject("rpc:chunk total_chunks must be a positive integer");
  }
  if (payload.column_metadata !== undefined) {
    const columnValidation = validateRecordArray(
      payload.column_metadata,
      "rpc:chunk column_metadata",
    );
    if (columnValidation !== null) {
      return columnValidation;
    }
  }
  return null;
};

const validateRpcComplete = (payload: unknown): ContractValidationFailure | null => {
  if (!isRecord(payload)) {
    return reject("rpc:complete payload must be an object");
  }
  const extraKey = ensureOnlyKeys(
    payload,
    new Set([
      "stream_id",
      "request_id",
      "total_rows",
      "affected_rows",
      "execution_id",
      "started_at",
      "finished_at",
      "terminal_status",
    ]),
  );
  if (extraKey !== null) {
    return extraKey;
  }
  if (typeof payload.stream_id !== "string" || payload.stream_id.trim() === "") {
    return reject("rpc:complete stream_id is required");
  }
  if (!isStringOrNumber(payload.request_id)) {
    return reject("rpc:complete request_id must be a string or number");
  }
  if (!isNonNegativeInteger(payload.total_rows)) {
    return reject("rpc:complete total_rows must be a non-negative integer");
  }
  if (payload.affected_rows !== undefined && !isNonNegativeInteger(payload.affected_rows)) {
    return reject("rpc:complete affected_rows must be a non-negative integer");
  }
  for (const key of ["execution_id", "started_at", "finished_at"] as const) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      return reject(`rpc:complete ${key} must be a string`);
    }
  }
  if (
    payload.terminal_status !== undefined &&
    payload.terminal_status !== "aborted" &&
    payload.terminal_status !== "error"
  ) {
    return reject("rpc:complete terminal_status must be aborted or error");
  }
  return null;
};

const validateRpcRequestAck = (payload: unknown): ContractValidationFailure | null => {
  if (!isRecord(payload)) {
    return reject("rpc:request_ack payload must be an object");
  }
  const extraKey = ensureOnlyKeys(payload, new Set(["request_id", "received_at"]));
  if (extraKey !== null) {
    return extraKey;
  }
  if (!isStringOrNumber(payload.request_id)) {
    return reject("rpc:request_ack request_id must be a string or number");
  }
  if (payload.received_at !== undefined && typeof payload.received_at !== "string") {
    return reject("rpc:request_ack received_at must be a string");
  }
  return null;
};

const validateRpcBatchAck = (payload: unknown): ContractValidationFailure | null => {
  if (!isRecord(payload)) {
    return reject("rpc:batch_ack payload must be an object");
  }
  const extraKey = ensureOnlyKeys(payload, new Set(["request_ids", "received_at"]));
  if (extraKey !== null) {
    return extraKey;
  }
  if (!Array.isArray(payload.request_ids) || payload.request_ids.length === 0) {
    return reject("rpc:batch_ack request_ids must be a non-empty array");
  }
  if (payload.request_ids.length > HUB_MAX_BATCH_SIZE) {
    return reject(`rpc:batch_ack request_ids cannot exceed ${HUB_MAX_BATCH_SIZE}`);
  }
  for (const requestId of payload.request_ids) {
    if (!isStringOrNumber(requestId)) {
      return reject("rpc:batch_ack request_ids items must be strings or numbers");
    }
  }
  if (payload.received_at !== undefined && typeof payload.received_at !== "string") {
    return reject("rpc:batch_ack received_at must be a string");
  }
  return null;
};

const validatePayloadForEvent = (
  eventName: AgentInboundContractEvent,
  payload: unknown,
): ContractValidationFailure | null => {
  if (eventName === socketEvents.rpcResponse) {
    return validateRpcResponse(payload);
  }
  if (eventName === socketEvents.rpcChunk) {
    return validateRpcChunk(payload);
  }
  if (eventName === socketEvents.rpcComplete) {
    return validateRpcComplete(payload);
  }
  if (eventName === socketEvents.rpcRequestAck) {
    return validateRpcRequestAck(payload);
  }
  return validateRpcBatchAck(payload);
};

export const validateAgentInboundContract = (
  input: AgentInboundContractValidationInput,
): AgentInboundContractValidationResult => {
  const mode: ContractValidationMode = env.socketAgentInboundContractValidation;
  if (mode === "off") {
    return { ok: true, shouldProcess: true };
  }

  const validation = validatePayloadForEvent(input.eventName, input.payload);
  if (validation === null) {
    return { ok: true, shouldProcess: true };
  }

  noteAgentInboundContractValidationFailed(mode);
  if (mode === "warn") {
    logger.warn("agent_inbound_contract_validation_failed", {
      eventName: input.eventName,
      socketId: input.socketId,
      reason: validation.message,
      mode,
    });
    return { ok: false, shouldProcess: true, message: validation.message };
  }

  return { ok: false, shouldProcess: false, message: validation.message };
};
