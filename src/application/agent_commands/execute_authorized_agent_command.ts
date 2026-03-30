/**
 * Facade that enforces agent access authorization before delegating to executeAgentCommand.
 * Shared by the REST channel and the Socket legacy agents:command channel.
 * Throws AppError on authorization failure, matching the existing error-handling pattern.
 */

import type { AgentAccessService } from "../services/agent_access.service";
import type { AgentCommandBody } from "../../shared/validators/agent_command";
import type { BridgeLatencyTraceSession } from "../services/bridge_latency_trace_builder";
import {
  executeAgentCommand,
  type AgentCommandDispatcher,
  type ExecuteAgentCommandResult,
  type RpcResponseNormalizer,
} from "./execute_agent_command";

export interface ExecuteAuthorizedAgentCommandInput {
  readonly userId: string;
  readonly agentId: string;
  readonly command: AgentCommandBody["command"];
  readonly timeoutMs?: number;
  readonly pagination?: AgentCommandBody["pagination"];
  readonly payloadFrameCompression?: AgentCommandBody["payloadFrameCompression"];
  readonly signal?: AbortSignal;
  readonly latencyTrace?: BridgeLatencyTraceSession;
}

export const executeAuthorizedAgentCommand = async (
  input: ExecuteAuthorizedAgentCommandInput,
  agentAccessService: AgentAccessService,
  dispatch: AgentCommandDispatcher,
  normalize: RpcResponseNormalizer,
): Promise<ExecuteAgentCommandResult> => {
  const accessResult = await agentAccessService.assertAccess(input.userId, input.agentId);
  if (!accessResult.ok) {
    throw accessResult.error;
  }

  return executeAgentCommand(
    {
      agentId: input.agentId,
      command: input.command,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.pagination !== undefined ? { pagination: input.pagination } : {}),
      ...(input.payloadFrameCompression !== undefined
        ? { payloadFrameCompression: input.payloadFrameCompression }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.latencyTrace ? { latencyTrace: input.latencyTrace } : {}),
    },
    dispatch,
    normalize,
  );
};
