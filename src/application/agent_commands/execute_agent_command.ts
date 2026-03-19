/**
 * Transport-agnostic use case for executing an agent RPC command.
 * Orchestrates pagination application, optional JSON-RPC `id` assignment (UUID when omitted),
 * dispatch to agent, and response normalization.
 * Used by HTTP controller and Socket consumer handler.
 */

import type { AgentCommandBody } from "../../shared/validators/agent_command";
import {
  applyPaginationToCommand,
  ensureJsonRpcIdsForBridge,
  normalizeCommandForAgent,
} from "./command_transformers";

export interface ExecuteAgentCommandInput {
  readonly agentId: string;
  readonly command: AgentCommandBody["command"];
  readonly timeoutMs?: number;
  readonly pagination?: AgentCommandBody["pagination"];
  readonly signal?: AbortSignal;
}

export interface DispatchRpcResponseResult {
  readonly requestId: string;
  readonly response: unknown;
}

export interface DispatchRpcNotificationResult {
  readonly requestId: string;
  readonly notification: true;
  readonly acceptedCommands: number;
}

export type DispatchRpcResult = DispatchRpcResponseResult | DispatchRpcNotificationResult;

export interface ExecuteAgentCommandResponseResult {
  readonly requestId: string;
  readonly response: unknown;
}

export interface ExecuteAgentCommandNotificationResult {
  readonly requestId: string;
  readonly notification: true;
  readonly acceptedCommands: number;
}

export type ExecuteAgentCommandResult =
  | ExecuteAgentCommandResponseResult
  | ExecuteAgentCommandNotificationResult;

export type AgentCommandDispatcher = (input: {
  readonly agentId: string;
  readonly command: AgentCommandBody["command"];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}) => Promise<DispatchRpcResult>;

export type RpcResponseNormalizer = (payload: unknown) => unknown;

export const executeAgentCommand = async (
  input: ExecuteAgentCommandInput,
  dispatch: AgentCommandDispatcher,
  normalize: RpcResponseNormalizer,
): Promise<ExecuteAgentCommandResult> => {
  const commandWithPagination = applyPaginationToCommand(input.command, input.pagination);
  const normalizedCommand = normalizeCommandForAgent(commandWithPagination);
  const commandForAgent = ensureJsonRpcIdsForBridge(normalizedCommand);

  const result = await dispatch({
    agentId: input.agentId,
    command: commandForAgent,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if ("notification" in result && result.notification) {
    return result;
  }

  if (!("response" in result)) {
    throw new Error("Invalid dispatch result: missing response payload");
  }

  return {
    requestId: result.requestId,
    response: normalize(result.response),
  };
};
