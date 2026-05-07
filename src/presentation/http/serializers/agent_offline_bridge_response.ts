import { randomUUID } from "node:crypto";

import type { AgentCommandBody } from "../../../shared/validators/agent_command";
import { isRecord, toJsonRpcId } from "../../../shared/utils/rpc_types";
import { isBatchCommand, toCorrelationIds } from "../../socket/hub/rpc_bridge_command_helpers";
import type {
  NormalizedAgentRpcResponse,
  NormalizedRpcItem,
} from "./agent_rpc_response.serializer";

const agentOfflineRpcError = (agentId: string) =>
  ({
    code: -32_000,
    message: "agent_offline",
    data: {
      reason: "agent_disconnected_at_dispatch",
      agent_id: agentId,
    },
  }) as const;

const extractItemMetaFields = (
  payload: Record<string, unknown>,
): { readonly api_version?: string; readonly meta?: Record<string, unknown> } => {
  const api_version = typeof payload.api_version === "string" ? payload.api_version : undefined;
  const meta = isRecord(payload.meta) ? payload.meta : undefined;
  return {
    ...(api_version !== undefined ? { api_version } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
};

export const resolveBridgeRequestIdFromCommand = (command: AgentCommandBody["command"]): string => {
  const correlationIds = toCorrelationIds(command);
  const firstCorrelationId = correlationIds.at(0);
  if (!isBatchCommand(command) && firstCorrelationId) {
    return firstCorrelationId;
  }
  return randomUUID();
};

export const buildAgentOfflineNormalizedResponse = (
  agentId: string,
  command: AgentCommandBody["command"],
): { readonly requestId: string; readonly response: NormalizedAgentRpcResponse } => {
  const requestId = resolveBridgeRequestIdFromCommand(command);
  const err = agentOfflineRpcError(agentId);

  if (isBatchCommand(command)) {
    const items: NormalizedRpcItem[] = command.map((item) => {
      const rec = item as unknown as Record<string, unknown>;
      return {
        id: toJsonRpcId(item.id),
        success: false,
        error: err,
        ...extractItemMetaFields(rec),
      };
    });

    return {
      requestId,
      response: {
        type: "batch",
        success: false,
        items,
      },
    };
  }

  const rec = command as unknown as Record<string, unknown>;
  const item: NormalizedRpcItem = {
    id: toJsonRpcId(command.id),
    success: false,
    error: err,
    ...extractItemMetaFields(rec),
  };

  return {
    requestId,
    response: {
      type: "single",
      success: false,
      item,
      ...(item.api_version ? { api_version: item.api_version } : {}),
      ...(item.meta ? { meta: item.meta } : {}),
    },
  };
};
