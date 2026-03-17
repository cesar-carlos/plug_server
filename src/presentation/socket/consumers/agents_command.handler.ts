/**
 * Socket handler for consumer commands to agents.
 * Reuses executeAgentCommand use case and shared validation.
 */

import type { Socket } from "socket.io";

import { executeAgentCommand } from "../../../application/agent_commands/execute_agent_command";
import { dispatchRpcCommandToAgent } from "../hub/rpc_bridge";
import { normalizeAgentRpcResponse } from "../../http/serializers/agent_rpc_response.serializer";
import { agentCommandBodySchema } from "../../../shared/validators/agent_command";
import { socketEvents } from "../../../shared/constants/socket_events";
import { isRecord } from "../../../shared/utils/rpc_types";
import { AppError } from "../../../shared/errors/app_error";

const emitCommandResponse = (
  socket: Socket,
  payload: { success: true; requestId: string; response: unknown } | { success: false; requestId?: string; error: { code: string; message: string; statusCode?: number } },
): void => {
  socket.emit(socketEvents.agentsCommandResponse, payload);
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, { message, code });
};

export const handleAgentsCommand = (socket: Socket, rawPayload: unknown): void => {
  if (!isRecord(rawPayload)) {
    emitAppError(socket, "agents:command payload must be an object");
    return;
  }

  const parsed = agentCommandBodySchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Validation failed";
    emitCommandResponse(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  const body = parsed.data;

  void executeAgentCommand(
    {
      agentId: body.agentId,
      command: body.command,
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.pagination !== undefined ? { pagination: body.pagination } : {}),
    },
    dispatchRpcCommandToAgent,
    normalizeAgentRpcResponse,
  )
    .then((result) => {
      emitCommandResponse(socket, {
        success: true,
        requestId: result.requestId,
        response: result.response,
      });
    })
    .catch((err: unknown) => {
      const appError = err instanceof AppError ? err : undefined;
      const code = appError?.code ?? "COMMAND_FAILED";
      const message = err instanceof Error ? err.message : "Command execution failed";
      const statusCode = appError?.statusCode;

      emitCommandResponse(socket, {
        success: false,
        error: {
          code,
          message,
          ...(typeof statusCode === "number" ? { statusCode } : {}),
        },
      });
    });
};
