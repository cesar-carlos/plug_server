/**
 * Socket handler for consumer commands to agents.
 * Reuses executeAgentCommand use case and shared validation (including auto JSON-RPC `id` when omitted).
 *
 * Wire format: outbound `agents:command_response` and stream events use `PayloadFrame` by default;
 * inbound `agents:command` accepts both plain JSON (legacy) and `PayloadFrame` during migration.
 * Set `SOCKET_AGENTS_COMMAND_COMPAT_MODE=raw_json` for legacy outbound plain JSON.
 * See `agentsCommandWireMigration` in `agent_bridge_parity.ts`.
 */

import type { Socket } from "socket.io";

import { executeAuthorizedAgentCommand } from "../../../application/agent_commands/execute_authorized_agent_command";
import { container } from "../../../shared/di/container";
import { createBridgeLatencyTraceIfSampled } from "../../../application/services/bridge_latency_trace_builder";
import { dispatchRpcCommandToAgent } from "../hub/relay/rpc_bridge";
import { buildAgentOfflineNormalizedResponse } from "../../http/serializers/agent_offline_bridge_response";
import { normalizeAgentRpcResponse } from "../../http/serializers/agent_rpc_response.serializer";
import { env } from "../../../shared/config/env";
import { agentCommandBodySchema } from "../../../shared/validators/agent_command";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import { AgentDisconnectedBeforeDispatchError } from "../../../shared/errors/agent_disconnected_before_dispatch.error";
import { AppError } from "../../../shared/errors/app_error";
import {
  allowAgentsCommandSocketAsync,
  estimateAgentsCommandRateLimitCost,
} from "../hub/rate_limits/agents_command_socket_rate_limiter";
import { assertConsumerSocketAgentAccess } from "./consumer_socket_guard";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";
import { toCorrelationIds } from "../hub/relay/rpc_bridge_command_helpers";
import { resolveAppErrorRetryAfterMs, resolveRpcRetryAfterSeconds } from "./socket_retry_after";
import {
  noteAgentsCommandRetryAfterSecondsPropagated,
  noteSocketErrorRetryAfterMsPropagated,
} from "../../../shared/metrics/socket_consumer.metrics";
import {
  buildAgentsCommandResponseForWire,
  buildAgentsCommandStreamEventForWire,
  decodeAgentsCommandInboundPayload,
  type AgentsCommandResponsePayload,
} from "./agents_command_wire";
import type { PayloadFrameCompressionPreference } from "../../../shared/utils/payload_frame";

const extractAgentsCommandRequestId = (rawPayload: unknown): string | undefined => {
  if (!isRecord(rawPayload)) {
    return undefined;
  }
  const command = rawPayload.command;
  if (Array.isArray(command)) {
    for (const item of command) {
      if (isRecord(item)) {
        const id = toRequestId(item.id);
        if (id) {
          return id;
        }
      }
    }
    return undefined;
  }
  if (isRecord(command)) {
    return toRequestId(command.id) ?? undefined;
  }
  return undefined;
};

const emitCommandResponse = (
  socket: Socket,
  payload: AgentsCommandResponsePayload,
  options?: {
    readonly payloadFrameCompression?: PayloadFrameCompressionPreference;
  },
): void => {
  if (socket.connected === false) {
    return;
  }
  const requestId = "requestId" in payload ? payload.requestId : undefined;
  socket.emit(
    socketEvents.agentsCommandResponse,
    buildAgentsCommandResponseForWire(payload, {
      ...(requestId !== undefined ? { requestId } : {}),
      ...(options?.payloadFrameCompression !== undefined
        ? { payloadFrameCompression: options.payloadFrameCompression }
        : {}),
    }),
  );
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, buildLegacySocketAppErrorPayload(code, message));
};

export const handleAgentsCommand = (socket: Socket, rawPayload: unknown): void => {
  const decodedInbound = decodeAgentsCommandInboundPayload(rawPayload);
  if (!decodedInbound.ok) {
    emitAppError(socket, decodedInbound.message);
    return;
  }

  const parsed = agentCommandBodySchema.safeParse(decodedInbound.data);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    const requestIdFallback = extractAgentsCommandRequestId(decodedInbound.data);
    emitCommandResponse(socket, {
      success: false,
      ...(requestIdFallback !== undefined ? { requestId: requestIdFallback } : {}),
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;
  const body = parsed.data;
  const correlationRequestId = toCorrelationIds(body.command)[0];
  const responseWireOptions =
    body.payloadFrameCompression !== undefined
      ? { payloadFrameCompression: body.payloadFrameCompression }
      : undefined;
  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
    emitCommandResponse(
      socket,
      {
        success: false,
        ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}),
        error: {
          code: "RATE_LIMITED",
          message: "Per-socket inflight gate exceeded",
          statusCode: 429,
        },
      },
      responseWireOptions,
    );
    return;
  }

  const latencyTrace = createBridgeLatencyTraceIfSampled({
    channel: "consumer_socket",
    userId: userSub,
  });
  const rateLimitCost = estimateAgentsCommandRateLimitCost(body.command);
  const abortController = new AbortController();
  const unregisterAbortController = registerConsumerCommandAbortController(
    socket.id,
    abortController,
  );
  const streamHandlers = {
    consumerSocketId: socket.id,
    onChunk: (payload: Record<string, unknown>): void => {
      socket.emit(
        socketEvents.agentsCommandStreamChunk,
        buildAgentsCommandStreamEventForWire(payload, {
          ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}),
        }),
      );
    },
    onComplete: (payload: Record<string, unknown>): void => {
      socket.emit(
        socketEvents.agentsCommandStreamComplete,
        buildAgentsCommandStreamEventForWire(payload, {
          ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}),
        }),
      );
    },
  } as const;

  void (async () => {
    try {
      if (!(await allowAgentsCommandSocketAsync(userSub, socket.id, rateLimitCost))) {
        emitCommandResponse(
          socket,
          {
            success: false,
            ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}),
            error: {
              code: "TOO_MANY_REQUESTS",
              message: "Too many agent commands, please try again later.",
              statusCode: 429,
            },
          },
          responseWireOptions,
        );
        return;
      }

      const principal = await assertConsumerSocketAgentAccess(
        socket.data.user,
        body.agentId,
        socket,
      );

      const result = await executeAuthorizedAgentCommand(
        {
          principal,
          agentId: body.agentId,
          command: body.command,
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
          ...(body.pagination !== undefined ? { pagination: body.pagination } : {}),
          ...(body.payloadFrameCompression !== undefined
            ? { payloadFrameCompression: body.payloadFrameCompression }
            : {}),
          signal: abortController.signal,
          ...(latencyTrace ? { latencyTrace } : {}),
        },
        container.agentAccessService,
        (input) =>
          dispatchRpcCommandToAgent({
            ...input,
            streamHandlers,
          }),
        normalizeAgentRpcResponse,
      );

      if ("notification" in result && result.notification) {
        const tWrite = performance.now();
        emitCommandResponse(
          socket,
          {
            success: true,
            requestId: result.requestId,
            response: {
              type: "notification",
              accepted: true,
              acceptedCommands: result.acceptedCommands,
            },
          },
          responseWireOptions,
        );
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
      const retryAfterSeconds = resolveRpcRetryAfterSeconds(normalizedResponse);
      if (retryAfterSeconds !== undefined) {
        noteAgentsCommandRetryAfterSecondsPropagated();
      }
      emitCommandResponse(
        socket,
        {
          success: true,
          requestId: result.requestId,
          response: normalizedResponse,
          ...(streamId ? { streamId } : {}),
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        },
        responseWireOptions,
      );
      latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWrite);
      latencyTrace?.finalizeOnce({ outcome: "success" });
    } catch (err: unknown) {
      if (err instanceof AgentDisconnectedBeforeDispatchError) {
        if (toCorrelationIds(err.command).length === 0) {
          if (latencyTrace && !latencyTrace.isFinalized()) {
            latencyTrace.finalizeOnce({
              outcome: "error",
              httpStatus: 503,
              errorCode: "SERVICE_UNAVAILABLE",
            });
          }
          emitCommandResponse(
            socket,
            {
              success: false,
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: `Agent ${err.agentId} is disconnected`,
                statusCode: 503,
              },
            },
            responseWireOptions,
          );
          return;
        }

        const { requestId, response: offlineRpcEnvelope } = buildAgentOfflineNormalizedResponse(
          err.agentId,
          err.command,
        );
        const tWriteOffline = performance.now();
        emitCommandResponse(
          socket,
          {
            success: true,
            requestId,
            response: offlineRpcEnvelope,
          },
          responseWireOptions,
        );
        latencyTrace?.addPhaseMs("response_write_ms", performance.now() - tWriteOffline);
        latencyTrace?.finalizeOnce({ outcome: "success", httpStatus: 200 });
        return;
      }

      const appError = err instanceof AppError ? err : undefined;
      const code = appError?.code ?? "COMMAND_FAILED";
      const message = err instanceof Error ? err.message : "Command execution failed";
      const statusCode = appError?.statusCode;
      const retryAfterMs = resolveAppErrorRetryAfterMs(err);
      if (retryAfterMs !== undefined) {
        noteSocketErrorRetryAfterMsPropagated();
      }

      if (latencyTrace && !latencyTrace.isFinalized()) {
        latencyTrace.finalizeOnce({
          outcome: "error",
          ...(typeof statusCode === "number" ? { httpStatus: statusCode } : {}),
          errorCode: code,
        });
      }

      emitCommandResponse(
        socket,
        {
          success: false,
          ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}),
          error: {
            code,
            message,
            ...(typeof statusCode === "number" ? { statusCode } : {}),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        },
        responseWireOptions,
      );
    } finally {
      unregisterAbortController();
      releaseSocketInflightSlot(socket);
    }
  })();
};
