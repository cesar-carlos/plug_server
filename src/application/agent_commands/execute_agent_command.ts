/**
 * Transport-agnostic use case for executing an agent RPC command.
 * Orchestrates pagination application, dispatch to agent, and response normalization.
 * Used by HTTP controller and Socket consumer handler.
 */

import type { AgentCommandBody } from "../../shared/validators/agent_command";
import { applyPaginationToCommand } from "./command_transformers";

export interface ExecuteAgentCommandInput {
  readonly agentId: string;
  readonly command: AgentCommandBody["command"];
  readonly timeoutMs?: number;
  readonly pagination?: AgentCommandBody["pagination"];
}

export interface DispatchRpcResult {
  readonly requestId: string;
  readonly response: unknown;
}

export type AgentCommandDispatcher = (input: {
  readonly agentId: string;
  readonly command: Record<string, unknown>;
  readonly timeoutMs?: number;
}) => Promise<DispatchRpcResult>;

export type RpcResponseNormalizer = (payload: unknown) => unknown;

export const executeAgentCommand = async (
  input: ExecuteAgentCommandInput,
  dispatch: AgentCommandDispatcher,
  normalize: RpcResponseNormalizer,
): Promise<{ readonly requestId: string; readonly response: unknown }> => {
  const commandObj = input.command as Record<string, unknown>;
  const commandWithPagination = applyPaginationToCommand(commandObj, input.pagination);

  const result = await dispatch({
    agentId: input.agentId,
    command: commandWithPagination,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  return {
    requestId: result.requestId,
    response: normalize(result.response),
  };
};
