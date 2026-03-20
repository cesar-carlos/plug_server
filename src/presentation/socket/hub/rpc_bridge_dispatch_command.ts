import { randomBytes, randomUUID } from "node:crypto";

import type { Namespace } from "socket.io";

import { env } from "../../../shared/config/env";
import {
  badRequest,
  notFound,
  serviceUnavailable,
  serviceUnavailableWithRetry,
} from "../../../shared/errors/http_errors";
import type { BridgeCommand, PayloadFrameCompression } from "../../../shared/validators/agent_command";
import { logger } from "../../../shared/utils/logger";
import { isRecord } from "../../../shared/utils/rpc_types";
import { socketEvents } from "../../../shared/constants/socket_events";
import { encodePayloadFrame, payloadFrameEncodeOptionsFromPreference } from "../../../shared/utils/payload_frame";
import { agentRegistry } from "./agent_registry";
import {
  getActiveStreamRouteByRequestId,
  hasActiveStreamRouteForRequestId,
  removeActiveStreamRoute,
  upsertActiveStreamRoute,
} from "./active_stream_registry";
import { ensureAgentCircuitClosed, registerAgentFailure, relayMetrics } from "./bridge_relay_health_metrics";
import { acquireRestAgentDispatchSlot } from "./rest_agent_dispatch_queue";
import type { PendingRequest, StreamEventHandlers } from "./rest_pending_requests";
import {
  clearRestPendingRequest,
  getRestPendingRequestCount,
  hasRestPendingCorrelationId,
  registerRestPendingRequest,
} from "./rest_pending_requests";
import { hasRelayRequestRoute } from "./relay_request_registry";
import {
  isBatchCommand,
  toCorrelationIds,
  withBridgeMeta,
} from "./rpc_bridge_command_helpers";

const defaultRequestTimeoutMs = 15_000;

export interface DispatchRpcCommandInput {
  readonly agentId: string;
  readonly command: BridgeCommand;
  readonly timeoutMs?: number;
  readonly streamHandlers?: StreamEventHandlers;
  readonly signal?: AbortSignal;
  /** Hub → agent PayloadFrame gzip policy for this dispatch. */
  readonly payloadFrameCompression?: PayloadFrameCompression;
}

interface DispatchRpcCommandResponseResult {
  readonly requestId: string;
  readonly response: unknown;
}

interface DispatchRpcCommandNotificationResult {
  readonly requestId: string;
  readonly notification: true;
  readonly acceptedCommands: number;
}

export type DispatchRpcCommandResult =
  | DispatchRpcCommandResponseResult
  | DispatchRpcCommandNotificationResult;

export interface RpcBridgeCommandDispatchDeps {
  readonly getAgentsNamespace: () => Namespace | null;
}

export const createDispatchRpcCommandToAgent = (
  deps: RpcBridgeCommandDispatchDeps,
): ((input: DispatchRpcCommandInput) => Promise<DispatchRpcCommandResult>) => {
  const { getAgentsNamespace } = deps;

  return async (input: DispatchRpcCommandInput): Promise<DispatchRpcCommandResult> => {
    if (input.signal?.aborted) {
      throw serviceUnavailable("HTTP request aborted by client");
    }

    const nsp = getAgentsNamespace();
    if (!nsp) {
      throw serviceUnavailable("Socket bridge is not initialized");
    }

    const registeredAgent = agentRegistry.findByAgentId(input.agentId);
    if (!registeredAgent) {
      if (agentRegistry.hasKnownAgentId(input.agentId)) {
        throw serviceUnavailable(`Agent ${input.agentId} is disconnected`);
      }

      throw notFound(`Agent ${input.agentId}`);
    }

    const agentSocket = nsp.sockets.get(registeredAgent.socketId);
    if (!agentSocket) {
      throw serviceUnavailable("Agent socket is unavailable");
    }
    ensureAgentCircuitClosed(input.agentId);

    if (!isRecord(input.command) && !Array.isArray(input.command)) {
      throw badRequest("Command must be a JSON object or JSON-RPC batch array");
    }

    const command = input.command;
    const correlationIds = toCorrelationIds(command);
    const firstCorrelationId = correlationIds.at(0);
    const requestId = !isBatchCommand(command) && firstCorrelationId ? firstCorrelationId : randomUUID();
    const traceId = randomBytes(16).toString("hex");
    const commandPayload = withBridgeMeta(command, {
      requestId,
      agentId: input.agentId,
      traceId,
      timestamp: new Date().toISOString(),
    });
    const timeoutMs = input.timeoutMs ?? defaultRequestTimeoutMs;
    const payloadFrameEncodeOpts = payloadFrameEncodeOptionsFromPreference(input.payloadFrameCompression);

    for (const correlationId of correlationIds) {
      if (
        hasRestPendingCorrelationId(correlationId) ||
        hasActiveStreamRouteForRequestId(correlationId) ||
        hasRelayRequestRoute(correlationId)
      ) {
        throw badRequest("A request with this JSON-RPC id is already pending");
      }
    }

    if (correlationIds.length === 0) {
      const releaseAgentSlot = await acquireRestAgentDispatchSlot(input.agentId, input.signal);
      try {
        agentSocket.emit(
          socketEvents.rpcRequest,
          encodePayloadFrame(commandPayload, {
            requestId,
            traceId,
            ...payloadFrameEncodeOpts,
          }),
        );

        return {
          requestId,
          notification: true,
          acceptedCommands: isBatchCommand(command) ? command.length : 1,
        };
      } catch (error: unknown) {
        registerAgentFailure(input.agentId);
        throw error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request");
      } finally {
        releaseAgentSlot();
      }
    }

    if (getRestPendingRequestCount() >= env.socketRestMaxPendingRequests) {
      relayMetrics.restPendingRejected += 1;
      throw serviceUnavailableWithRetry(
        "REST bridge pending request capacity reached",
        env.socketRestAgentQueueWaitMs,
      );
    }

    const releaseAgentSlot = await acquireRestAgentDispatchSlot(input.agentId, input.signal);
    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let signalListener: (() => void) | null = null;

        const rejectOnce = (error: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (signalListener) {
            input.signal?.removeEventListener("abort", signalListener);
          }
          reject(error);
        };

        const resolveOnce = (payload: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (signalListener) {
            input.signal?.removeEventListener("abort", signalListener);
          }
          resolve(payload);
        };

        const timeoutHandle = setTimeout(() => {
          const hadAck = pendingRequest.acked;
          clearRestPendingRequest(pendingRequest);
          const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
          if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
            removeActiveStreamRoute(existingStream);
          }
          if (!hadAck) {
            logger.info("rpc_timeout_without_ack", {
              requestId: pendingRequest.primaryRequestId,
              socketId: registeredAgent.socketId,
            });
          }
          registerAgentFailure(input.agentId);
          rejectOnce(serviceUnavailable("Timed out waiting for agent response"));
        }, timeoutMs);

        const restStreamAggregate =
          input.streamHandlers === undefined &&
          !isBatchCommand(command) &&
          command.method === "sql.execute" &&
          correlationIds.length === 1;

        const pendingRequest: PendingRequest = {
          primaryRequestId: requestId,
          correlationIds,
          socketId: registeredAgent.socketId,
          agentId: input.agentId,
          createdAtMs: Date.now(),
          resolve: resolveOnce,
          reject: rejectOnce,
          timeoutHandle,
          ...(
            !isBatchCommand(command) &&
            command.method === "sql.execute" &&
            input.streamHandlers &&
            correlationIds.length === 1
              ? { streamHandlers: input.streamHandlers }
              : {}
          ),
          ...(restStreamAggregate ? { restStreamAggregate: true } : {}),
          acked: false,
        };

        signalListener = () => {
          clearTimeout(timeoutHandle);
          clearRestPendingRequest(pendingRequest);
          const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
          if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
            removeActiveStreamRoute(existingStream);
          }
          rejectOnce(serviceUnavailable("HTTP request aborted by client"));
        };

        if (input.signal) {
          input.signal.addEventListener("abort", signalListener, { once: true });
          if (input.signal.aborted) {
            signalListener();
            return;
          }
        }

        registerRestPendingRequest(pendingRequest);

        if (pendingRequest.streamHandlers) {
          upsertActiveStreamRoute({
            requestId,
            agentSocketId: registeredAgent.socketId,
            streamHandlers: pendingRequest.streamHandlers,
          });
        }

        try {
          agentSocket.emit(
            socketEvents.rpcRequest,
            encodePayloadFrame(commandPayload, {
              requestId,
              traceId,
              ...payloadFrameEncodeOpts,
            }),
          );
        } catch (error: unknown) {
          clearTimeout(timeoutHandle);
          clearRestPendingRequest(pendingRequest);
          const existingStream = getActiveStreamRouteByRequestId(requestId);
          if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
            removeActiveStreamRoute(existingStream);
          }
          registerAgentFailure(input.agentId);
          rejectOnce(error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request"));
        }
      });

      return {
        requestId,
        response,
      };
    } finally {
      releaseAgentSlot();
    }
  };
};
