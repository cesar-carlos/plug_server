/**
 * Pure transformers for agent RPC commands.
 * Shared between HTTP controller and Socket consumer handler.
 */

import { randomUUID } from "node:crypto";

import type { AgentCommandBody } from "../../shared/validators/agent_command";
import { isRecord } from "../../shared/utils/rpc_types";

import { env } from "../../shared/config/env";
import { logger } from "../../shared/utils/logger";

const logAutoAssignedJsonRpcId = (context: {
  readonly method: string;
  readonly assignedId: string;
  readonly batchIndex?: number;
}): void => {
  const payload = {
    event: "bridge_jsonrpc_id_assigned",
    method: context.method,
    assigned_id: context.assignedId,
    ...(context.batchIndex !== undefined ? { batch_index: context.batchIndex } : {}),
  };

  if (env.bridgeLogJsonRpcAutoId) {
    logger.info("bridge_jsonrpc_id_assigned", payload);
  } else {
    logger.debug("bridge_jsonrpc_id_assigned", payload);
  }
};

/**
 * JSON-RPC 2.0: when `id` is omitted, the bridge assigns a UUID before forwarding so the agent can
 * correlate `rpc:response`. Explicit `id: null` stays a **notification** (no response); do not inject.
 */
export const ensureJsonRpcIdsForBridge = (
  command: AgentCommandBody["command"],
): AgentCommandBody["command"] => {
  if (Array.isArray(command)) {
    return command.map((item, batchIndex) => {
      if (item.id !== undefined) {
        return item;
      }
      const assignedId = randomUUID();
      logAutoAssignedJsonRpcId({ method: item.method, assignedId, batchIndex });
      return { ...item, id: assignedId };
    }) as AgentCommandBody["command"];
  }

  if (command.id === undefined) {
    const assignedId = randomUUID();
    logAutoAssignedJsonRpcId({ method: command.method, assignedId });
    return { ...command, id: assignedId } as AgentCommandBody["command"];
  }

  return command;
};

/**
 * Normalizes command options before sending to agent.
 * Converts preserve_sql: true to execution_mode: "preserve" and removes preserve_sql
 * to avoid redundant payload and ensure consistent semantics.
 */
export const normalizeCommandForAgent = (
  command: AgentCommandBody["command"],
): AgentCommandBody["command"] => {
  if (Array.isArray(command)) {
    return command.map((item) => {
      if (item.method !== "sql.execute" || !isRecord(item.params?.options)) {
        return item;
      }
      const opts = item.params.options as Record<string, unknown>;
      if (opts.preserve_sql !== true) {
        return item;
      }
      if (env.nodeEnv !== "production") {
        logger.warn("preserve_sql is deprecated; use execution_mode: 'preserve' instead");
      }
      const { preserve_sql: _preserveSql, ...rest } = opts;
      return {
        ...item,
        params: {
          ...item.params,
          options: { ...rest, execution_mode: "preserve" },
        },
      };
    }) as AgentCommandBody["command"];
  }

  if (command.method !== "sql.execute" || !isRecord(command.params?.options)) {
    return command;
  }

  const opts = command.params.options as Record<string, unknown>;
  if (opts.preserve_sql !== true) {
    return command;
  }

  if (env.nodeEnv !== "production") {
    logger.warn("preserve_sql is deprecated; use execution_mode: 'preserve' instead");
  }

  const { preserve_sql: _preserveSql, ...rest } = opts;
  return {
    ...command,
    params: {
      ...command.params,
      options: { ...rest, execution_mode: "preserve" },
    },
  };
};

export const applyPaginationToCommand = (
  command: AgentCommandBody["command"],
  pagination: AgentCommandBody["pagination"],
): AgentCommandBody["command"] => {
  if (!pagination || Array.isArray(command) || command.method !== "sql.execute") {
    return command;
  }

  const currentParams = command.params;
  const currentOptions = isRecord(currentParams.options) ? currentParams.options : {};
  const { page: _page, page_size: _pageSize, cursor: _cursor, ...restOptions } =
    currentOptions as Record<string, unknown>;

  const paginationOptions =
    pagination.cursor !== undefined
      ? { cursor: pagination.cursor }
      : { page: pagination.page, page_size: pagination.pageSize };

  return {
    ...command,
    params: {
      ...currentParams,
      options: {
        ...restOptions,
        ...paginationOptions,
      },
    },
  };
};
