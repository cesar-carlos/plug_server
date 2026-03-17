import type { NextFunction, Request, Response } from "express";

import { executeAgentCommand } from "../../../application/agent_commands/execute_agent_command";
import { agentRegistry } from "../../socket/hub/agent_registry";
import { agentsNamespace } from "../../../socket";
import { dispatchRpcCommandToAgent } from "../../socket/hub/rpc_bridge";
import { normalizeAgentRpcResponse } from "../serializers/agent_rpc_response.serializer";
import { getValidated } from "../middlewares/validate.middleware";
import type { AgentCommandBody } from "../validators/agents.validator";
import { env } from "../../../shared/config/env";

export const listConnectedAgents = (_request: Request, response: Response): void => {
  const agents = agentRegistry.listAll();
  const payload: {
    agents: ReturnType<typeof agentRegistry.listAll>;
    count: number;
    _diagnostic?: { socketConnectionsInAgentsNamespace: number };
  } = {
    agents,
    count: agents.length,
  };

  if (env.nodeEnv !== "production" && agentsNamespace) {
    payload._diagnostic = {
      socketConnectionsInAgentsNamespace: agentsNamespace.sockets.size,
    };
  }

  response.status(200).json(payload);
};

export const proxyCommandToAgent = async (
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> => {
  const body = getValidated<AgentCommandBody>(response, "body");

  try {
    const result = await executeAgentCommand(
      {
        agentId: body.agentId,
        command: body.command,
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.pagination !== undefined ? { pagination: body.pagination } : {}),
      },
      dispatchRpcCommandToAgent,
      normalizeAgentRpcResponse,
    );

    response.status(200).json({
      mode: "bridge",
      agentId: body.agentId,
      requestId: result.requestId,
      response: result.response,
    });
  } catch (error: unknown) {
    next(error);
  }
};
