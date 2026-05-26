import type { BridgeBatchCommand, BridgeCommand } from "../../../../shared/validators/agent_command";
import { HUB_DEFAULT_API_VERSION } from "../../../../shared/constants/agent_transport_contract";
import { isBatchCommand, toCorrelationIds } from "../../../../shared/utils/bridge_command_correlation";
import { isRecord, toRequestId } from "../../../../shared/utils/rpc_types";

export { isBatchCommand, toCorrelationIds };

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

export const resolveOutboundApiVersion = (record: Record<string, unknown>): string => {
  const v = record.api_version;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : HUB_DEFAULT_API_VERSION;
};

const OUTBOUND_RPC_META_KEYS = [
  "trace_id",
  "traceparent",
  "tracestate",
  "request_id",
  "agent_id",
  "timestamp",
] as const;

/**
 * Keep bridge-originated `meta` aligned with the published plug_agente schema.
 * The hub may accept extra metadata from callers for compatibility, but it must
 * not forward hub-only or undocumented fields to the agent.
 */
export const sanitizeOutboundRpcMeta = (
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  if (!meta) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};
  for (const key of OUTBOUND_RPC_META_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && value.trim() !== "") {
      sanitized[key] = value.trim();
    }
  }

  return sanitized;
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
      const existingMeta = sanitizeOutboundRpcMeta(toRecord(item.meta));
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
  const existingMeta = sanitizeOutboundRpcMeta(toRecord(command.meta));
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

const READ_ONLY_SQL_PREFIXES = ["select", "with", "show", "describe", "desc", "explain"] as const;

const normalizeSqlPrefix = (sql: string): string => sql.trimStart().toLowerCase();

const isReadOnlySql = (sql: string): boolean => {
  const normalized = normalizeSqlPrefix(sql);
  return READ_ONLY_SQL_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
};

const hasRpcParamsIdempotencyKey = (command: Record<string, unknown>): boolean => {
  const params = toRecord(command.params);
  return typeof params?.idempotency_key === "string" && params.idempotency_key.trim() !== "";
};

const isReadSafeRpcCommand = (command: Record<string, unknown>): boolean => {
  const method = command.method;
  if (
    method === "agent.getHealth" ||
    method === "agent.getProfile" ||
    method === "agent.action.getExecution" ||
    method === "agent.action.validateRun" ||
    method === "client_token.getPolicy" ||
    method === "rpc.discover"
  ) {
    return true;
  }

  const params = toRecord(command.params);
  if (!params) {
    return false;
  }

  if (method === "sql.execute") {
    return typeof params.sql === "string" && isReadOnlySql(params.sql);
  }

  if (method === "sql.executeBatch") {
    const commands = Array.isArray(params.commands) ? params.commands : [];
    return (
      commands.length > 0 &&
      commands.every((item) => {
        const itemRecord = toRecord(item);
        return (
          itemRecord !== null && typeof itemRecord.sql === "string" && isReadOnlySql(itemRecord.sql)
        );
      })
    );
  }

  return false;
};

export const isAckRetryEligibleCommand = (command: BridgeCommand): boolean => {
  if (isBatchCommand(command)) {
    if (command.length === 0 || command.some((item) => item.id === null || item.id === undefined)) {
      return false;
    }

    const items = command.map((item) => item as unknown as Record<string, unknown>);
    return (
      items.every(hasRpcParamsIdempotencyKey) || items.every((item) => isReadSafeRpcCommand(item))
    );
  }

  if (command.id === null || command.id === undefined) {
    return false;
  }

  const commandRecord = command as unknown as Record<string, unknown>;
  return hasRpcParamsIdempotencyKey(commandRecord) || isReadSafeRpcCommand(commandRecord);
};
