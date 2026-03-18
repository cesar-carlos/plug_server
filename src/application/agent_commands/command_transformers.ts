/**
 * Pure transformers for agent RPC commands.
 * Shared between HTTP controller and Socket consumer handler.
 */

import type { AgentCommandBody } from "../../shared/validators/agent_command";
import { isRecord } from "../../shared/utils/rpc_types";

export const applyPaginationToCommand = (
  command: AgentCommandBody["command"],
  pagination: AgentCommandBody["pagination"],
): AgentCommandBody["command"] => {
  if (!pagination || Array.isArray(command) || command.method !== "sql.execute") {
    return command;
  }

  const currentParams = command.params;
  const currentOptions = isRecord(currentParams.options) ? currentParams.options : {};

  const paginationOptions =
    pagination.cursor !== undefined
      ? { cursor: pagination.cursor }
      : { page: pagination.page, page_size: pagination.pageSize };

  return {
    ...command,
    params: {
      ...currentParams,
      options: {
        ...currentOptions,
        ...paginationOptions,
      },
    },
  };
};
