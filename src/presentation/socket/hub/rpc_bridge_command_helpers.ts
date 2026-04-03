import type { BridgeBatchCommand, BridgeCommand } from "../../../shared/validators/agent_command";
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

const clampSingleCommandMaxRows = (
  command: BridgeCommand,
  maxRows: number,
): { readonly command: BridgeCommand; readonly adjusted: boolean } => {
  if (Array.isArray(command)) {
    let adjusted = false;
    const next = command.map((item) => {
      if (item.method === "sql.execute") {
        const current = item.params.options?.max_rows;
        if (typeof current === "number" && Number.isFinite(current) && current > maxRows) {
          adjusted = true;
          return {
            ...item,
            params: {
              ...item.params,
              options: {
                ...item.params.options,
                max_rows: maxRows,
              },
            },
          };
        }
        return item;
      }
      if (item.method === "sql.executeBatch") {
        const current = item.params.options?.max_rows;
        if (typeof current === "number" && Number.isFinite(current) && current > maxRows) {
          adjusted = true;
          return {
            ...item,
            params: {
              ...item.params,
              options: {
                ...item.params.options,
                max_rows: maxRows,
              },
            },
          };
        }
        return item;
      }
      return item;
    }) as BridgeBatchCommand;
    return { command: next, adjusted };
  }

  if (command.method === "sql.execute") {
    const current = command.params.options?.max_rows;
    if (typeof current !== "number" || !Number.isFinite(current) || current <= maxRows) {
      return { command, adjusted: false };
    }
    return {
      adjusted: true,
      command: {
        ...command,
        params: {
          ...command.params,
          options: {
            ...command.params.options,
            max_rows: maxRows,
          },
        },
      },
    };
  }

  if (command.method === "sql.executeBatch") {
    const current = command.params.options?.max_rows;
    if (typeof current !== "number" || !Number.isFinite(current) || current <= maxRows) {
      return { command, adjusted: false };
    }
    return {
      adjusted: true,
      command: {
        ...command,
        params: {
          ...command.params,
          options: {
            ...command.params.options,
            max_rows: maxRows,
          },
        },
      },
    };
  }

  return { command, adjusted: false };
};

export const clampCommandMaxRows = (
  command: BridgeCommand,
  maxRows: number,
): { readonly command: BridgeCommand; readonly adjusted: boolean } => {
  const safeMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : maxRows;
  if (typeof safeMaxRows !== "number" || !Number.isFinite(safeMaxRows) || safeMaxRows <= 0) {
    return { command, adjusted: false };
  }
  return clampSingleCommandMaxRows(command, safeMaxRows);
};

export const countBatchItems = (command: BridgeCommand): number => {
  return Array.isArray(command) ? command.length : 1;
};

export const hasNotificationCommand = (command: BridgeCommand): boolean => {
  if (Array.isArray(command)) {
    return command.some((item) => item.id === null);
  }
  return command.id === null;
};
