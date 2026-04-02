/**
 * Socket handler for consumer commands to agents.
 * Reuses executeAgentCommand use case and shared validation (including auto JSON-RPC `id` when omitted).
 */

import type { Socket } from "socket.io";

import { executeAuthorizedAgentCommand } from "../../../application/agent_commands/execute_authorized_agent_command";
import { container } from "../../../shared/di/container";
import { createBridgeLatencyTraceIfSampled } from "../../../application/services/bridge_latency_trace_builder";
import { dispatchRpcCommandToAgent } from "../hub/rpc_bridge";
import { normalizeAgentRpcResponse } from "../../http/serializers/agent_rpc_response.serializer";
import { agentCommandBodySchema } from "../../../shared/validators/agent_command";
import { socketEvents } from "../../../shared/constants/socket_events";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import { AppError } from "../../../shared/errors/app_error";
import { allowAgentsCommandSocket } from "../hub/agents_command_socket_rate_limiter";
import type { AgentAccessPrincipal } from "../../../application/services/agent_access.service";

const emitCommandResponse = (
  socket: Socket,
  payload:
    | { success: true; requestId: string; response: unknown; streamId?: string }
    | {
        success: false;
        requestId?: string;
        error: { code: string; message: string; statusCode?: number };
      },
): void => {
  socket.emit(socketEvents.agentsCommandResponse, payload);
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, { message, code });
};

const resolveAgentAccessPrincipal = (socket: Socket): AgentAccessPrincipal | null => {
  const sub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;
  if (!sub) {
    return null;
  }
  return socket.data.user?.principal_type === "client"
    ? { type: "client", id: sub }
    : {
        type: "user",
        id: sub,
        ...(socket.data.user?.role !== undefined ? { role: socket.data.user.role } : {}),
      };
};

export const handleAgentsCommand = (socket: Socket, rawPayload: unknown): void => {
  if (!isRecord(rawPayload)) {
    emitAppError(socket, "agents:command payload must be an object");
    return;
  }

  const parsed = agentCommandBodySchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitCommandResponse(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  const principal = resolveAgentAccessPrincipal(socket);
  const userSub = principal?.id;
  if (!allowAgentsCommandSocket(userSub, socket.id)) {
    emitCommandResponse(socket, {
      success: false,
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many agent commands, please try again later.",
        statusCode: 429,
      },
    });
    return;
  }

  if (!principal) {
    emitCommandResponse(socket, {
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required", statusCode: 401 },
    });
    return;
  }

  const body = parsed.data;
  const latencyTrace = createBridgeLatencyTraceIfSampled({
    channel: "consumer_socket",
    userId: userSub,
  });
  const streamHandlers = {
    consumerSocketId: socket.id,
    onChunk: (payload: Record<string, unknown>): void => {
      socket.emit(socketEvents.agentsCommandStreamChunk, payload);
    },
    onComplete: (payload: Record<string, unknown>): void => {
      socket.emit(socketEvents.agentsCommandStreamComplete, payload);
    },
  } as const;

  void executeAuthorizedAgentCommand(
    {
      principal,
      agentId: body.agentId,
      command: body.command,
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.pagination !== undefined ? { pagination: body.pagination } : {}),
      ...(body.payloadFrameCompression !== undefined
        ? { payloadFrameCompression: body.payloadFrameCompression }
        : {}),
      ...(latencyTrace ? { latencyTrace } : {}),
    },
    container.agentAccessService,
    (input) =>
      dispatchRpcCommandToAgent({
        ...input,
        streamHandlers,
      }),
    normalizeAgentRpcResponse,
  )
    .then((result) => {
      if ("notification" in result && result.notification) {
        const tWrite = performance.now();
        emitCommandResponse(socket, {
          success: true,
          requestId: result.requestId,
          response: {
            type: "notification",
            accepted: true,
            acceptedCommands: result.acceptedCommands,
          },
        });
        latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWrite);
        latencyTrace?.finalizeOnce({ outcome: "notification" });
        return;
      }
      if (!("response" in result)) {
        throw new Error("Invalid command result: missing response payload");
      }

      const normalizedResponse = result.response;
      const streamId = isRecord(normalizedResponse)
        ? (() => {
            const item = isRecord(normalizedResponse.item) ? normalizedResponse.item : null;
            const rpcResult = item && isRecord(item.result) ? item.result : null;
            return rpcResult ? toRequestId(rpcResult.stream_id) : null;
          })()
        : null;

      const tWrite = performance.now();
      emitCommandResponse(socket, {
        success: true,
        requestId: result.requestId,
        response: normalizedResponse,
        ...(streamId ? { streamId } : {}),
      });
      latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWrite);
      latencyTrace?.finalizeOnce({ outcome: "success" });
    })
    .catch((err: unknown) => {
      const appError = err instanceof AppError ? err : undefined;
      const code = appError?.code ?? "COMMAND_FAILED";
      const message = err instanceof Error ? err.message : "Command execution failed";
      const statusCode = appError?.statusCode;

      if (latencyTrace && !latencyTrace.isFinalized()) {
        latencyTrace.finalizeOnce({
          outcome: "error",
          ...(typeof statusCode === "number" ? { httpStatus: statusCode } : {}),
          errorCode: code,
        });
      }

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
