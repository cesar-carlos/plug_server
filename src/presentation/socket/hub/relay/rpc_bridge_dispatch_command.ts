import { randomUUID } from "node:crypto";

import {
  inferBridgeCommandMethod,
  type BridgeLatencyTraceSession,
} from "../../../../application/services/bridge_latency_trace_builder";
import {
  observeBridgeRpcMethod,
  type BridgeRpcMethodMetricOutcome,
} from "../../../../application/services/bridge_rpc_method_metrics.service";
import {
  buildBridgeCommandReplayDetectedResponse,
  getCompletedBridgeCommandReplay,
  getSingleBridgeCommandReplayId,
  rememberCompletedBridgeCommand,
} from "../../../../application/agent_commands/bridge_command_replay_guard";
import { env } from "../../../../shared/config/env";
import { AgentDisconnectedBeforeDispatchError } from "../../../../shared/errors/agent_disconnected_before_dispatch.error";
import { AppError } from "../../../../shared/errors/app_error";
import {
  badRequest,
  notFound,
  serviceUnavailable,
  serviceUnavailableWithRetry,
} from "../../../../shared/errors/http_errors";
import type {
  BridgeCommand,
  PayloadFrameCompression,
} from "../../../../shared/validators/agent_command";
import { logger } from "../../../../shared/utils/logger";
import { noteAgentHealthRpcResponse } from "../../../../shared/metrics/socket_agent.metrics";
import { isRecord } from "../../../../shared/utils/rpc_types";
import { socketEvents } from "../../../../shared/constants/socket_events";
import {
  encodePayloadFrameBridge,
  payloadFrameEncodeOptionsFromPreference,
  type PayloadFrameEnvelope,
} from "../../../../shared/utils/payload_frame";
import { agentRegistry } from "../registries/agent_registry";
import {
  getActiveStreamRouteByRequestId,
  hasActiveStreamRouteForRequestId,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  ensureAgentCircuitClosed,
  noteBridgeAckRetryAttempt,
  noteBridgeAckRetryExhausted,
  registerAgentFailure,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import { acquireRestAgentDispatchSlot } from "./rest_agent_dispatch_queue";
import { resolveAgentCompressionPreference } from "./relay_compression_preference";
import type { PendingRequest, StreamEventHandlers } from "../registries/rest_pending_requests";
import {
  clearRestPendingRequest,
  getRestPendingRequestByCorrelationId,
  getRestPendingRequestCount,
  tryRegisterRestPendingRequest,
} from "../registries/rest_pending_requests";
import { hasRelayRequestRoute } from "../registries/relay_request_registry";
import {
  clampCommandMaxRows,
  countBatchItems,
  isAckRetryEligibleCommand,
  isBatchCommand,
  toCorrelationIds,
  withBridgeMeta,
} from "./rpc_bridge_command_helpers";

const defaultRequestTimeoutMs = 15_000;

export interface DispatchRpcCommandInput {
  readonly agentId: string;
  readonly command: BridgeCommand;
  readonly timeoutMs?: number | undefined;
  readonly streamHandlers?: StreamEventHandlers | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Hub → agent PayloadFrame gzip policy for this dispatch. */
  readonly payloadFrameCompression?: PayloadFrameCompression | undefined;
  readonly latencyTrace?: BridgeLatencyTraceSession | undefined;
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

type AgentSocketEmitter = {
  emit: (eventName: string, payload: unknown) => void;
};

export interface RpcBridgeCommandDispatchDeps {
  readonly hasRegisteredAgentSocketBridge: () => boolean;
  readonly findAgentSocketById: (socketId: string) => AgentSocketEmitter | null;
}

export const createDispatchRpcCommandToAgent = (
  deps: RpcBridgeCommandDispatchDeps,
): ((input: DispatchRpcCommandInput) => Promise<DispatchRpcCommandResult>) => {
  const { hasRegisteredAgentSocketBridge, findAgentSocketById } = deps;

  return async (input: DispatchRpcCommandInput): Promise<DispatchRpcCommandResult> => {
    const dispatchWallStart = performance.now();
    const method = inferBridgeCommandMethod(input.command);
    const channel = input.latencyTrace?.channel ?? "unknown";
    let metricOutcome: BridgeRpcMethodMetricOutcome = "error";

    try {
      if (input.signal?.aborted) {
        metricOutcome = "abort";
        throw serviceUnavailable("HTTP request aborted by client");
      }

      if (!hasRegisteredAgentSocketBridge()) {
        throw serviceUnavailable("Socket bridge is not initialized");
      }

      const registeredAgent = agentRegistry.findByAgentId(input.agentId);
      if (!registeredAgent) {
        if (agentRegistry.hasKnownAgentId(input.agentId)) {
          throw new AgentDisconnectedBeforeDispatchError(input.agentId, input.command);
        }

        throw notFound(`Agent ${input.agentId}`);
      }

      const agentSocket = findAgentSocketById(registeredAgent.socketId);
      if (!agentSocket) {
        throw new AgentDisconnectedBeforeDispatchError(input.agentId, input.command);
      }
      const readiness = agentRegistry.getProtocolReadiness(input.agentId);
      if (!readiness.ready) {
        throw serviceUnavailableWithRetry(
          `Agent ${input.agentId} protocol negotiation is not ready`,
          readiness.retryAfterMs,
        );
      }
      ensureAgentCircuitClosed(input.agentId);

      if (!isRecord(input.command) && !Array.isArray(input.command)) {
        throw badRequest("Command must be a JSON object or JSON-RPC batch array");
      }

      const effectivePolicy = agentRegistry.resolveEffectiveDispatchPolicy(input.agentId);
      const effectiveCompressionPreference = resolveAgentCompressionPreference({
        preference: input.payloadFrameCompression,
        allowsNoneCompression: effectivePolicy.allowsNoneCompression,
        allowsGzip: effectivePolicy.allowsGzip,
        buildUnsupportedError: () =>
          serviceUnavailable("Agent transport capabilities are incompatible with hub compression"),
      });

      const rawCommand = input.command;
      if (
        isBatchCommand(rawCommand) &&
        countBatchItems(rawCommand) > effectivePolicy.maxBatchSize
      ) {
        throw badRequest(
          `Batch cannot exceed negotiated max_batch_size (${effectivePolicy.maxBatchSize})`,
        );
      }
      const clamped = clampCommandMaxRows(rawCommand, effectivePolicy.maxRows);
      if (clamped.adjusted && logger.isLevelEnabled("debug")) {
        logger.debug("bridge_command_max_rows_clamped", {
          agentId: input.agentId,
          maxRows: effectivePolicy.maxRows,
        });
      }
      const command = clamped.command;

      const correlationIds = toCorrelationIds(command);
      const firstCorrelationId = correlationIds.at(0);
      const requestId =
        !isBatchCommand(command) && firstCorrelationId ? firstCorrelationId : randomUUID();
      const traceId = randomUUID();
      input.latencyTrace?.attachDispatchMeta({
        requestId,
        traceId,
        jsonRpcMethod: inferBridgeCommandMethod(command),
        agentId: input.agentId,
      });
      const timeoutMs = input.timeoutMs ?? defaultRequestTimeoutMs;
      const payloadFrameEncodeOpts = payloadFrameEncodeOptionsFromPreference(
        effectiveCompressionPreference,
      );
      const replayId = getSingleBridgeCommandReplayId(command);

      const completedReplay = getCompletedBridgeCommandReplay({
        agentId: input.agentId,
        command,
      });
      if (completedReplay) {
        input.latencyTrace?.addPhaseMs(
          "dispatch_preflight_ms",
          performance.now() - dispatchWallStart,
        );
        logger.info("bridge_command_replay_detected", {
          agentId: input.agentId,
          requestId,
          idType: completedReplay.replayId.idType,
          source: "completed_window",
        });
        metricOutcome = "success";
        return {
          requestId,
          response: completedReplay.response,
        };
      }

      for (const correlationId of correlationIds) {
        if (replayId && replayId.requestId === correlationId) {
          const existingPending = getRestPendingRequestByCorrelationId(correlationId);
          if (existingPending) {
            input.latencyTrace?.addPhaseMs(
              "dispatch_preflight_ms",
              performance.now() - dispatchWallStart,
            );
            logger.info("bridge_command_replay_detected", {
              agentId: input.agentId,
              requestId,
              idType: replayId.idType,
              source: "in_flight",
            });
            metricOutcome = "success";
            return {
              requestId,
              response: buildBridgeCommandReplayDetectedResponse(replayId),
            };
          }
        }
      }

      const commandPayload = withBridgeMeta(command, {
        requestId,
        agentId: input.agentId,
        traceId,
        timestamp: new Date().toISOString(),
      });

      if (correlationIds.length === 0) {
        input.latencyTrace?.addPhaseMs(
          "dispatch_preflight_ms",
          performance.now() - dispatchWallStart,
        );
        const tQueue = performance.now();
        const releaseAgentSlot = await acquireRestAgentDispatchSlot(input.agentId, input.signal);
        input.latencyTrace?.addPhaseMs("queue_wait_ms", performance.now() - tQueue);
        try {
          const tEnc = performance.now();
          const wire = await encodePayloadFrameBridge(commandPayload, {
            requestId,
            omitTraceId: true,
            ...payloadFrameEncodeOpts,
          });
          input.latencyTrace?.addPhaseMs("encode_ms", performance.now() - tEnc);
          const tEmit = performance.now();
          agentSocket.emit(socketEvents.rpcRequest, wire);
          const emitEnded = performance.now();
          input.latencyTrace?.addPhaseMs("emit_to_socket_ms", emitEnded - tEmit);

          metricOutcome = "notification";
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
        relayMetrics.restGlobalPendingCapRejected += 1;
        throw serviceUnavailableWithRetry(
          "REST bridge pending request capacity reached",
          env.socketRestAgentQueueWaitMs,
        );
      }
      const ackRetryEligible =
        env.socketAgentAckRetryEnabled &&
        env.socketAgentAckMaxRetries > 0 &&
        isAckRetryEligibleCommand(command);

      input.latencyTrace?.addPhaseMs(
        "dispatch_preflight_ms",
        performance.now() - dispatchWallStart,
      );

      // Idempotent release: callable both early (when the response is promoted to
      // a streaming materialization, see PendingRequest.onStreamMaterializeStarted)
      // and from the outer `finally`. Subsequent calls are no-ops, so we never
      // over-decrement the per-agent inflight counter.
      let agentSlotReleased = false;
      let rawReleaseAgentSlot: (() => void) | null = null;
      const releaseAgentSlot = (): void => {
        if (agentSlotReleased || rawReleaseAgentSlot === null) {
          return;
        }
        agentSlotReleased = true;
        rawReleaseAgentSlot();
      };

      let pendingRegistered = false;
      let pendingRequest!: PendingRequest;
      let pendingSignalListener: (() => void) | null = null;
      let pendingSettled = false;

      const finalizePendingLatencyTrace = (error: Error): void => {
        if (!input.latencyTrace || input.latencyTrace.isFinalized()) {
          return;
        }
        const appErr = error instanceof AppError ? error : null;
        const msg = error.message;
        const outcome =
          msg.includes("Timed out waiting") || msg.includes("Timed out")
            ? "timeout"
            : msg.includes("aborted")
              ? "abort"
              : "error";
        input.latencyTrace.finalizeOnce({
          outcome,
          httpStatus: appErr?.statusCode ?? 503,
          errorCode: appErr?.code ?? "BRIDGE_ERROR",
        });
      };

      const clearPendingRegistration = (): void => {
        if (!pendingRegistered) {
          return;
        }
        clearTimeout(pendingRequest.timeoutHandle);
        clearRestPendingRequest(pendingRequest);
        pendingRegistered = false;
      };

      const isPendingRequestStillRegistered = (): boolean =>
        pendingRequest.correlationIds.some(
          (correlationId) => getRestPendingRequestByCorrelationId(correlationId) === pendingRequest,
        );

      const scheduleAckRetry = (wireFrame: PayloadFrameEnvelope): void => {
        if (!ackRetryEligible) {
          return;
        }

        pendingRequest.ackRetryTimer = setTimeout(() => {
          delete pendingRequest.ackRetryTimer;
          if (
            pendingSettled ||
            pendingRequest.acked ||
            !isPendingRequestStillRegistered() ||
            input.signal?.aborted === true
          ) {
            return;
          }
          if ((pendingRequest.ackRetriesAttempted ?? 0) >= env.socketAgentAckMaxRetries) {
            return;
          }

          const liveAgentSocket = findAgentSocketById(registeredAgent.socketId);
          if (!liveAgentSocket) {
            return;
          }

          pendingRequest.ackRetriesAttempted = (pendingRequest.ackRetriesAttempted ?? 0) + 1;
          noteBridgeAckRetryAttempt("rest");
          logger.info("rpc_request_ack_retry_emit", {
            requestId: pendingRequest.primaryRequestId,
            attempt: pendingRequest.ackRetriesAttempted,
            socketId: registeredAgent.socketId,
          });
          liveAgentSocket.emit(socketEvents.rpcRequest, wireFrame);

          if (
            !pendingRequest.acked &&
            (pendingRequest.ackRetriesAttempted ?? 0) < env.socketAgentAckMaxRetries &&
            isPendingRequestStillRegistered()
          ) {
            scheduleAckRetry(wireFrame);
          }
        }, env.socketAgentAckTimeoutMs);
        pendingRequest.ackRetryTimer.unref?.();
      };

      const responsePromise = new Promise<unknown>((resolve, reject) => {
        const rejectOnce = (error: Error): void => {
          if (pendingSettled) {
            return;
          }
          pendingSettled = true;
          if (pendingSignalListener) {
            input.signal?.removeEventListener("abort", pendingSignalListener);
          }
          finalizePendingLatencyTrace(error);
          reject(error);
        };

        const resolveOnce = (payload: unknown): void => {
          if (pendingSettled) {
            return;
          }
          pendingSettled = true;
          if (pendingSignalListener) {
            input.signal?.removeEventListener("abort", pendingSignalListener);
          }
          resolve(payload);
        };

        const timeoutHandle = setTimeout(() => {
          // Current hub-side delivery guarantee is observational: we track
          // `rpc:request_ack` / `rpc:batch_ack` and Socket.IO response acks for
          // troubleshooting, but we do not automatically resend `rpc:request`
          // when an ack is missing. Timeout remains the terminal safeguard.
          const hadAck = pendingRequest.acked;
          clearPendingRegistration();
          const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
          if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
            removeActiveStreamRoute(existingStream, { restMaterialize: "detach" });
          }
          if (!hadAck) {
            if (
              ackRetryEligible &&
              (pendingRequest.ackRetriesAttempted ?? 0) >= env.socketAgentAckMaxRetries
            ) {
              noteBridgeAckRetryExhausted("rest");
            }
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

        pendingRequest = {
          primaryRequestId: requestId,
          correlationIds,
          socketId: registeredAgent.socketId,
          agentId: input.agentId,
          createdAtMs: Date.now(),
          resolve: resolveOnce,
          reject: rejectOnce,
          timeoutHandle,
          ...(!isBatchCommand(command) &&
          command.method === "sql.execute" &&
          input.streamHandlers &&
          correlationIds.length === 1
            ? { streamHandlers: input.streamHandlers }
            : {}),
          ...(restStreamAggregate ? { restStreamAggregate: true } : {}),
          ...(restStreamAggregate ? { onStreamMaterializeStarted: releaseAgentSlot } : {}),
          ...(input.latencyTrace ? { latencyTrace: input.latencyTrace } : {}),
          acked: false,
          ackRetriesAttempted: 0,
        };

        if (
          !tryRegisterRestPendingRequest(
            pendingRequest,
            hasActiveStreamRouteForRequestId,
            hasRelayRequestRoute,
          )
        ) {
          clearTimeout(timeoutHandle);
          rejectOnce(badRequest("A request with this JSON-RPC id is already pending"));
          return;
        }
        pendingRegistered = true;

        pendingSignalListener = () => {
          clearPendingRegistration();
          const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
          if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
            removeActiveStreamRoute(existingStream, { restMaterialize: "detach" });
          }
          rejectOnce(serviceUnavailable("HTTP request aborted by client"));
        };

        if (input.signal) {
          input.signal.addEventListener("abort", pendingSignalListener, { once: true });
          if (input.signal.aborted) {
            pendingSignalListener();
            return;
          }
        }
      });
      void responsePromise.catch(() => undefined);

      if (pendingSettled) {
        await responsePromise;
        throw serviceUnavailable("HTTP request aborted by client");
      }

      const tQueuePending = performance.now();
      try {
        rawReleaseAgentSlot = await acquireRestAgentDispatchSlot(input.agentId, input.signal);
      } catch (error: unknown) {
        clearPendingRegistration();
        if (!pendingSettled) {
          pendingRequest.reject(
            error instanceof Error
              ? error
              : serviceUnavailable("Failed to acquire agent dispatch slot"),
          );
        }
        throw error;
      }
      input.latencyTrace?.addPhaseMs("queue_wait_ms", performance.now() - tQueuePending);

      try {
        let wireFrame: PayloadFrameEnvelope;
        try {
          const tEncPending = performance.now();
          wireFrame = await encodePayloadFrameBridge(commandPayload, {
            requestId,
            omitTraceId: true,
            ...payloadFrameEncodeOpts,
          });
          input.latencyTrace?.addPhaseMs("encode_ms", performance.now() - tEncPending);
        } catch (error: unknown) {
          clearPendingRegistration();
          registerAgentFailure(input.agentId);
          if (!pendingSettled) {
            pendingRequest.reject(
              error instanceof Error ? error : serviceUnavailable("Failed to encode rpc:request"),
            );
          }
          throw error instanceof Error ? error : serviceUnavailable("Failed to encode rpc:request");
        }

        if (input.signal?.aborted) {
          clearPendingRegistration();
          const abortError = serviceUnavailable("HTTP request aborted by client");
          if (!pendingSettled) {
            pendingRequest.reject(abortError);
          }
          throw abortError;
        }

        try {
          const tEmitPending = performance.now();
          agentSocket.emit(socketEvents.rpcRequest, wireFrame);
          const emitEndedPending = performance.now();
          input.latencyTrace?.markEmitComplete(emitEndedPending - tEmitPending, emitEndedPending);
          scheduleAckRetry(wireFrame);
        } catch (error: unknown) {
          clearPendingRegistration();
          const existingStream = getActiveStreamRouteByRequestId(requestId);
          if (existingStream && existingStream.agentSocketId === registeredAgent.socketId) {
            removeActiveStreamRoute(existingStream, { restMaterialize: "detach" });
          }
          registerAgentFailure(input.agentId);
          const emitError =
            error instanceof Error ? error : serviceUnavailable("Failed to emit rpc:request");
          if (!pendingSettled) {
            pendingRequest.reject(emitError);
          }
          throw emitError;
        }

        const response = await responsePromise;
        rememberCompletedBridgeCommand({
          agentId: input.agentId,
          command,
        });

        if (!isBatchCommand(command) && command.method === "agent.getHealth") {
          noteAgentHealthRpcResponse(response);
        }

        metricOutcome = "success";
        return {
          requestId,
          response,
        };
      } finally {
        releaseAgentSlot();
      }
    } catch (error: unknown) {
      if (metricOutcome === "error") {
        const message = error instanceof Error ? error.message : "";
        if (input.signal?.aborted === true || message.includes("aborted")) {
          metricOutcome = "abort";
        } else if (message.includes("Timed out") || message.includes("timed out")) {
          metricOutcome = "timeout";
        }
      }
      throw error;
    } finally {
      observeBridgeRpcMethod({
        channel,
        method,
        outcome: metricOutcome,
        elapsedMs: performance.now() - dispatchWallStart,
      });
    }
  };
};
