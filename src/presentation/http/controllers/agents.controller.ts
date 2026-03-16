import type { NextFunction, Request, Response } from "express";

import { agentRegistry } from "../../socket/hub/agent_registry";
import { dispatchRpcCommandToAgent } from "../../socket/hub/rpc_bridge";
import { normalizeAgentRpcResponse } from "../serializers/agent_rpc_response.serializer";
import { getValidated } from "../middlewares/validate.middleware";
import type { AgentCommandBody } from "../validators/agents.validator";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const applyPaginationToCommand = (
  command: Record<string, unknown>,
  pagination: AgentCommandBody["pagination"],
): Record<string, unknown> => {
  if (!pagination) {
    return command;
  }

  const currentParams = isRecord(command.params) ? command.params : {};
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

export const listConnectedAgents = (_request: Request, response: Response): void => {
  const agents = agentRegistry.listAll();
  response.status(200).json({
    agents,
    count: agents.length,
  });
};

export const proxyCommandToAgent = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<AgentCommandBody>(response, "body");
  const commandWithPagination = applyPaginationToCommand(body.command, body.pagination);

  try {
    const result = await dispatchRpcCommandToAgent({
      agentId: body.agentId,
      command: commandWithPagination,
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    });

    response.status(200).json({
      mode: "bridge",
      agentId: body.agentId,
      requestId: result.requestId,
      response: normalizeAgentRpcResponse(result.response),
    });
  } catch (error: unknown) {
    next(error);
  }
};
