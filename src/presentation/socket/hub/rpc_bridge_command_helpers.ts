import type {
  BridgeBatchCommand,
  BridgeCommand,
} from "../../../shared/validators/agent_command";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export const pickResponseIds = (payload: unknown): readonly string[] => {
  if (Array.isArray(payload)) {
    const ids: string[] = [];
    for (const item of payload) {
      const record = toRecord(item);
      if (!record) {
        continue;
      }
      const id = toRequestId(record.id);
      if (!id) {
        continue;
      }
      ids.push(id);
    }
    return ids;
  }

  const record = toRecord(payload);
  if (!record) {
    return [];
  }

  const id = toRequestId(record.id);
  return id ? [id] : [];
};

export const isBatchCommand = (command: BridgeCommand): command is BridgeBatchCommand => {
  return Array.isArray(command);
};

export const toCorrelationIds = (command: BridgeCommand): readonly string[] => {
  if (isBatchCommand(command)) {
    const ids: string[] = [];
    for (const item of command) {
      const id = toRequestId(item.id);
      if (id) {
        ids.push(id);
      }
    }
    return ids;
  }

  const singleId = toRequestId(command.id);
  return singleId ? [singleId] : [];
};

export const resolveOutboundApiVersion = (record: Record<string, unknown>): string => {
  const v = record.api_version;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "2.5";
};

export const withBridgeMeta = (
  command: BridgeCommand,
  input: {
    readonly requestId: string;
    readonly agentId: string;
    readonly traceId: string;
    readonly timestamp: string;
  },
): BridgeCommand => {
  if (isBatchCommand(command)) {
    return command.map((item) => {
      const itemRecord = item as unknown as Record<string, unknown>;
      const existingMeta = toRecord(item.meta) ?? {};
      const itemRequestId = toRequestId(item.id) ?? input.requestId;
      return {
        ...item,
        api_version: resolveOutboundApiVersion(itemRecord),
        meta: {
          ...existingMeta,
          request_id: itemRequestId,
          agent_id: input.agentId,
          timestamp: input.timestamp,
          trace_id: input.traceId,
        },
      };
    });
  }

  const cmdRecord = command as unknown as Record<string, unknown>;
  const existingMeta = toRecord(command.meta) ?? {};
  return {
    ...command,
    api_version: resolveOutboundApiVersion(cmdRecord),
    meta: {
      ...existingMeta,
      request_id: input.requestId,
      agent_id: input.agentId,
      timestamp: input.timestamp,
      trace_id: input.traceId,
    },
  };
};

export const extractStreamIdFromRpcResponse = (payload: unknown): string | null => {
  const record = toRecord(payload);
  if (!record) {
    return null;
  }

  const result = toRecord(record.result);
  if (!result) {
    return null;
  }

  return toRequestId(result.stream_id);
};
