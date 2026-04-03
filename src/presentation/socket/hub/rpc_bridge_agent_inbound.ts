import {
  appendSqlStreamChunkRows,
  countSqlExecuteResultRowsInEnvelope,
  countSqlStreamChunkRows,
  mergeSqlStreamRpcResponse,
  mergeSqlStreamRpcResponseWithAppendedRows,
} from "../../../application/agent_commands/merge_sql_stream_rpc_response";
import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { serviceUnavailable } from "../../../shared/errors/http_errors";
import { logger } from "../../../shared/utils/logger";
import {
  decodePayloadFrameAsync,
  finishPayloadFrameEnvelope,
  isPayloadFrameEnvelope,
  preencodePayloadFrameJson,
} from "../../../shared/utils/payload_frame";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import type { ActiveStreamRoute } from "./active_stream_registry";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
  resolveActiveStreamRoute,
  upsertActiveStreamRoute,
} from "./active_stream_registry";
import {
  logRpcFrameDecodeFailure,
  observeRelayFrameDecode,
  observeAgentLatency,
  registerAgentFailure,
  registerAgentSuccess,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import { agentRegistry } from "./agent_registry";
import { conversationRegistry } from "./conversation_registry";
import {
  REST_STREAM_AGGREGATE_CONSUMER_ID,
  restSqlStreamMaterializeConsumeChunk,
  restSqlStreamMaterializeSeedCredits,
} from "./rest_sql_stream_materialize";
import type { StreamEventHandlers } from "./rest_pending_requests";
import {
  clearRestPendingRequest,
  findRestPendingRequestByIds,
  getRestPendingRequestByCorrelationId,
} from "./rest_pending_requests";
import { getOrCreateRelayIdempotencyMap } from "./relay_idempotency_store";
import { setRelayStreamFlowCredits, getRelayStreamForwardedRows } from "./relay_stream_flow_state";
import {
  findRelayRequestRouteForAgentSocket,
  getRelayRequestRoute,
  removeRelayRequestRoute,
} from "./relay_request_registry";
import { createRelayStreamHandlers, type EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import { extractStreamIdFromRpcResponse, pickResponseIds } from "./rpc_bridge_command_helpers";

const relayIdempotencyTtlMs = env.socketRelayIdempotencyTtlMs;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export interface RpcBridgeAgentInboundDeps {
  readonly emitToConsumer: EmitToConsumerFn;
  readonly emitRpcStreamPullForRoute: (route: ActiveStreamRoute, windowSize: number) => void;
}

export type RpcBridgeAgentInboundHandlers = {
  /**
   * Optional `ack` is the Socket.IO acknowledgment callback when the agent uses
   * `emitWithAck` / `emitWithAckAsync` on `rpc:response` (plug_agente delivery guarantees).
   */
  readonly handleAgentRpcResponse: (
    socketId: string,
    rawPayload: unknown,
    ack?: () => void,
  ) => void;
  readonly handleAgentRpcChunk: (socketId: string, rawPayload: unknown) => void;
  readonly handleAgentRpcComplete: (socketId: string, rawPayload: unknown) => void;
  readonly handleAgentRpcAck: (socketId: string, rawPayload: unknown) => void;
  readonly handleAgentBatchAck: (socketId: string, rawPayload: unknown) => void;
};

export const createRpcBridgeAgentInboundHandlers = (
  deps: RpcBridgeAgentInboundDeps,
): RpcBridgeAgentInboundHandlers => {
  const { emitToConsumer, emitRpcStreamPullForRoute } = deps;
  const streamInboundTailBySocketId = new Map<string, Promise<void>>();

  const enqueueOrderedStreamInbound = (socketId: string, work: () => Promise<void>): void => {
    const prev = streamInboundTailBySocketId.get(socketId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => {
        logger.warn("rpc_stream_inbound_processing_failed", {
          socketId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    streamInboundTailBySocketId.set(socketId, next);
    void next.finally(() => {
      if (streamInboundTailBySocketId.get(socketId) === next) {
        streamInboundTailBySocketId.delete(socketId);
      }
    });
  };

  const extractFrameRequestId = (rawPayload: unknown): string | null => {
    if (!isPayloadFrameEnvelope(rawPayload)) {
      return null;
    }
    return toRequestId(rawPayload.requestId);
  };

  const createRelayDecodeFailurePayload = (
    requestId: string,
    reasonMessage: string,
  ): Record<string, unknown> => {
    const timestamp = new Date().toISOString();
    const normalized = reasonMessage.toLowerCase();
    if (normalized.includes("signature")) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32001,
          message: "Authentication failed",
          data: {
            reason: "invalid_signature",
            category: "auth",
            retryable: false,
            user_message: "Nao foi possivel autenticar a resposta do agente.",
            technical_message: reasonMessage,
            correlation_id: `corr-${requestId}`,
            timestamp,
          },
        },
      };
    }
    if (normalized.includes("decode payloadframe json payload")) {
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32010,
          message: "Decoding failed",
          data: {
            reason: "decoding_failed",
            category: "transport",
            retryable: false,
            user_message: "Nao foi possivel decodificar a resposta do agente.",
            technical_message: reasonMessage,
            correlation_id: `corr-${requestId}`,
            timestamp,
          },
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32009,
        message: "Invalid payload",
        data: {
          reason: "invalid_payload",
          category: "transport",
          retryable: false,
          user_message: "O agente respondeu com um payload invalido.",
          technical_message: reasonMessage,
          correlation_id: `corr-${requestId}`,
          timestamp,
        },
      },
    };
  };

  const failFastInvalidAgentResponseFrame = (
    socketId: string,
    rawPayload: unknown,
    reasonMessage: string,
  ): void => {
    const requestId = extractFrameRequestId(rawPayload);
    if (!requestId) {
      return;
    }

    const pendingRequest = getRestPendingRequestByCorrelationId(requestId);
    if (pendingRequest && pendingRequest.socketId === socketId) {
      clearTimeout(pendingRequest.timeoutHandle);
      clearRestPendingRequest(pendingRequest);
      const existingStream = getActiveStreamRouteByRequestId(pendingRequest.primaryRequestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream, { restMaterialize: "detach" });
      }
      registerAgentFailure(pendingRequest.agentId);
      pendingRequest.reject(
        serviceUnavailable(`Failed to decode agent rpc:response frame: ${reasonMessage}`),
      );
    }

    const relayRoute = getRelayRequestRoute(requestId);
    if (!relayRoute || relayRoute.agentSocketId !== socketId) {
      return;
    }

    relayRoute.latencyTrace?.finalizeOnce({
      outcome: "error",
      errorCode: "AGENT_FRAME_DECODE_FAILED",
    });
    enqueueRelayOutbound(requestId, async () => {
      const frame = await encodeRelayOutboundFrame(
        createRelayDecodeFailurePayload(requestId, reasonMessage),
        requestId,
      );
      emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, frame);
      const existingStream = getActiveStreamRouteByRequestId(requestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream);
      }
      removeRelayRequestRoute(requestId);
    });
  };

  const emitRelayTerminalFailure = (
    route: ActiveStreamRoute,
    socketId: string,
    reasonMessage: string,
  ): void => {
    const relayRoute = getRelayRequestRoute(route.requestId);
    if (!relayRoute || relayRoute.agentSocketId !== socketId) {
      return;
    }

    relayMetrics.streamTerminalCompletions += 1;
    relayRoute.latencyTrace?.finalizeOnce({
      outcome: "error",
      httpStatus: 503,
      errorCode: "AGENT_STREAM_FRAME_DECODE_FAILED",
    });
    enqueueRelayOutbound(route.requestId, async () => {
      const terminalPayload: Record<string, unknown> = {
        request_id: route.requestId,
        total_rows: getRelayStreamForwardedRows(route.requestId),
        terminal_status: "error",
        ...(route.streamId ? { stream_id: route.streamId } : {}),
      };
      const frame = await encodeRelayOutboundFrame(terminalPayload, route.requestId);
      emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcComplete, frame);
      void recordSocketAuditEvent({
        eventType: socketEvents.relayRpcComplete,
        actorSocketId: socketId,
        direction: "agent_to_consumer",
        conversationId: relayRoute.conversationId,
        agentId: relayRoute.agentId,
        requestId: route.requestId,
        ...(route.streamId ? { streamId: route.streamId } : {}),
      });
      const existingStream = getActiveStreamRouteByRequestId(route.requestId);
      if (existingStream && existingStream.agentSocketId === socketId) {
        removeActiveStreamRoute(existingStream);
      }
      removeRelayRequestRoute(route.requestId);
      logger.warn("relay_stream_failed_fast", {
        requestId: route.requestId,
        conversationId: relayRoute.conversationId,
        socketId,
        reason: reasonMessage,
      });
    });
  };

  const failFastInvalidAgentStreamFrame = (
    eventName: string,
    socketId: string,
    rawPayload: unknown,
    reasonMessage: string,
  ): void => {
    const requestId = extractFrameRequestId(rawPayload);
    if (!requestId) {
      return;
    }

    const route = getActiveStreamRouteByRequestId(requestId);
    if (!route || route.agentSocketId !== socketId) {
      return;
    }

    const failureMessage = `Failed to decode agent ${eventName} frame: ${reasonMessage}`;
    if (route.restMaterializeState && !route.restMaterializeState.settled) {
      route.restMaterializeState.settled = true;
      clearTimeout(route.restMaterializeState.timeoutHandle);
      registerAgentFailure(route.restMaterializeState.agentId);
      removeActiveStreamRoute(route, { restMaterialize: "detach" });
      route.restMaterializeState.reject(serviceUnavailable(failureMessage));
      return;
    }

    if (route.mode === "relay") {
      emitRelayTerminalFailure(route, socketId, reasonMessage);
      return;
    }

    try {
      route.onComplete({
        request_id: route.requestId,
        total_rows: 0,
        terminal_status: "error",
        ...(route.streamId ? { stream_id: route.streamId } : {}),
      });
    } finally {
      removeActiveStreamRoute(route);
    }
  };

  const handleAgentRpcResponse = (
    socketId: string,
    rawPayload: unknown,
    ack?: () => void,
  ): void => {
    const inboundSyncStart = performance.now();
    const decodeStart = performance.now();
    void decodePayloadFrameAsync(rawPayload).then((result) => {
      const decodeMs = performance.now() - decodeStart;
      let ackInvoked = false;
      const fireAck = (): void => {
        if (ackInvoked || typeof ack !== "function") {
          return;
        }
        ackInvoked = true;
        try {
          ack();
        } catch {
          /* ignore: consumer disconnected */
        }
      };

      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcResponse,
          socketId,
          reason: result.error.message,
        });
        failFastInvalidAgentResponseFrame(socketId, rawPayload, result.error.message);
        fireAck();
        return;
      }

      try {
        const decoded = result.value;
        const frameRequestId = toRequestId(decoded.frame.requestId);
        const responseIds = pickResponseIds(decoded.data);
        const candidateIds = Array.from(
          new Set([...responseIds, ...(frameRequestId ? [frameRequestId] : [])]),
        );

        if (candidateIds.length === 0) {
          return;
        }

        const streamId = extractStreamIdFromRpcResponse(decoded.data);
        const pendingRequest = findRestPendingRequestByIds(socketId, candidateIds);
        if (pendingRequest) {
          pendingRequest.latencyTrace?.markInboundArrival(inboundSyncStart);
          pendingRequest.latencyTrace?.recordInboundDecodeMs(decodeMs);
          const pendingRequestId = pendingRequest.primaryRequestId;
          const deferredRestStream =
            Boolean(streamId) && pendingRequest.restStreamAggregate === true;

          if (deferredRestStream) {
            const initialJson = decoded.data;
            const timeoutHandle = pendingRequest.timeoutHandle;
            const resolveOnce = pendingRequest.resolve;
            const rejectOnce = pendingRequest.reject;
            const primaryRequestId = pendingRequestId;
            const streamedRows: unknown[] = [];
            const pullWindow = agentRegistry.resolveStreamPullWindow(
              pendingRequest.agentId,
              env.socketRestStreamPullWindowSize,
            );
            const materializeMaxRows = env.socketRestSqlStreamMaterializeMaxRows;
            const materializeMaxChunks = env.socketRestSqlStreamMaterializeMaxChunks;
            let aggregatedRowCount = countSqlExecuteResultRowsInEnvelope(initialJson);
            let chunkFramesSeen = 0;

            if (materializeMaxRows > 0 && aggregatedRowCount > materializeMaxRows) {
              relayMetrics.restMaterializeRowLimitExceeded += 1;
              registerAgentFailure(pendingRequest.agentId);
              clearTimeout(pendingRequest.timeoutHandle);
              clearRestPendingRequest(pendingRequest);
              pendingRequest.reject(
                serviceUnavailable(
                  "REST SQL stream materialization would exceed configured row limit (use Socket bridge for large streams)",
                ),
              );
              return;
            }

            const restMaterializeState = {
              settled: false,
              timeoutHandle,
              reject: rejectOnce,
              agentId: pendingRequest.agentId,
            };

            const streamHandlers: StreamEventHandlers = {
              consumerSocketId: REST_STREAM_AGGREGATE_CONSUMER_ID,
              mode: "legacy",
              onChunk: (payload) => {
                chunkFramesSeen += 1;
                if (materializeMaxChunks > 0 && chunkFramesSeen > materializeMaxChunks) {
                  relayMetrics.restMaterializeChunkLimitExceeded += 1;
                  registerAgentFailure(pendingRequest.agentId);
                  const route = getActiveStreamRouteByRequestId(primaryRequestId);
                  if (route) {
                    removeActiveStreamRoute(route, { restMaterialize: "detach" });
                  }
                  rejectOnce(
                    serviceUnavailable(
                      "REST SQL stream materialization exceeded configured chunk limit (use Socket bridge for large streams)",
                    ),
                  );
                  return;
                }

                const chunkRows = countSqlStreamChunkRows(payload);
                if (materializeMaxRows > 0 && aggregatedRowCount + chunkRows > materializeMaxRows) {
                  relayMetrics.restMaterializeRowLimitExceeded += 1;
                  registerAgentFailure(pendingRequest.agentId);
                  const route = getActiveStreamRouteByRequestId(primaryRequestId);
                  if (route) {
                    removeActiveStreamRoute(route, { restMaterialize: "detach" });
                  }
                  rejectOnce(
                    serviceUnavailable(
                      "REST SQL stream materialization exceeded configured row limit (use Socket bridge for large streams)",
                    ),
                  );
                  return;
                }

                aggregatedRowCount += chunkRows;
                appendSqlStreamChunkRows(streamedRows, payload);
                restSqlStreamMaterializeConsumeChunk(primaryRequestId, pullWindow, () => {
                  const route = getActiveStreamRouteByRequestId(primaryRequestId);
                  if (route) {
                    emitRpcStreamPullForRoute(route, pullWindow);
                  }
                });
              },
              onComplete: (payload) => {
                restMaterializeState.settled = true;
                clearTimeout(timeoutHandle);
                try {
                  const merged =
                    streamedRows.length > 0
                      ? mergeSqlStreamRpcResponseWithAppendedRows(initialJson, streamedRows, payload)
                      : mergeSqlStreamRpcResponse(initialJson, [], payload);
                  relayMetrics.restSqlStreamMaterializeCompleted += 1;
                  relayMetrics.restSqlStreamMaterializeRowsMerged +=
                    countSqlExecuteResultRowsInEnvelope(merged);
                  pendingRequest.latencyTrace?.recordPendingResolveEnd();
                  resolveOnce(merged);
                } catch (err) {
                  const mergeError =
                    err instanceof Error ? err : new Error("Failed to merge SQL stream");
                  if (
                    mergeError.message.startsWith("Agent SQL stream ended with terminal_status=")
                  ) {
                    rejectOnce(serviceUnavailable(mergeError.message));
                    return;
                  }
                  rejectOnce(mergeError);
                }
              },
            };

            upsertActiveStreamRoute({
              requestId: primaryRequestId,
              agentSocketId: socketId,
              streamHandlers,
              streamId: streamId as string,
              restMaterializeState,
            });
            registerAgentSuccess(pendingRequest.agentId);
            observeAgentLatency(pendingRequest.agentId, Date.now() - pendingRequest.createdAtMs);
            clearRestPendingRequest(pendingRequest);

            const route = getActiveStreamRouteByRequestId(primaryRequestId);
            if (route) {
              emitRpcStreamPullForRoute(route, pullWindow);
              restSqlStreamMaterializeSeedCredits(primaryRequestId, pullWindow);
            }
            return;
          }

          if (pendingRequest.streamHandlers) {
            if (streamId) {
              upsertActiveStreamRoute({
                requestId: pendingRequestId,
                agentSocketId: socketId,
                streamHandlers: pendingRequest.streamHandlers,
                streamId,
              });
              logger.debug("rpc_stream_registered", {
                requestId: pendingRequestId,
                streamId,
                socketId,
              });
            } else {
              const existingStream = getActiveStreamRouteByRequestId(pendingRequestId);
              if (existingStream && existingStream.agentSocketId === socketId) {
                removeActiveStreamRoute(existingStream);
              }
            }
          }

          if (!pendingRequest.acked) {
            logger.info("rpc_response_received_without_ack", {
              requestId: pendingRequestId,
              socketId,
            });
          }

          registerAgentSuccess(pendingRequest.agentId);
          observeAgentLatency(pendingRequest.agentId, Date.now() - pendingRequest.createdAtMs);
          clearTimeout(pendingRequest.timeoutHandle);
          clearRestPendingRequest(pendingRequest);
          pendingRequest.latencyTrace?.recordPendingResolveEnd();
          pendingRequest.resolve(decoded.data);
        }

        const relayRoute = findRelayRequestRouteForAgentSocket(candidateIds, socketId);

        if (!relayRoute) {
          return;
        }

        relayRoute.latencyTrace?.markInboundArrival(inboundSyncStart);
        relayRoute.latencyTrace?.recordInboundDecodeMs(decodeMs);

        const responseId = relayRoute.requestId;

        observeAgentLatency(relayRoute.agentId, Date.now() - relayRoute.createdAtMs);
        registerAgentSuccess(relayRoute.agentId);
        clearTimeout(relayRoute.timeoutHandle);
        conversationRegistry.touchInternal(relayRoute.conversationId);

        if (streamId) {
          relayRoute.latencyTrace?.markRelayStreamOpenWall();
          upsertActiveStreamRoute({
            requestId: responseId,
            agentSocketId: socketId,
            streamHandlers: createRelayStreamHandlers(relayRoute, emitToConsumer),
            streamId,
          });
          setRelayStreamFlowCredits(responseId, 0);
        }

        enqueueRelayOutbound(responseId, async () => {
          const responseFrame = await encodeRelayOutboundFrame(decoded.data, responseId);
          const tRelayForward = performance.now();
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, responseFrame);
          relayRoute.latencyTrace?.addPhaseMs(
            "relay_forward_to_consumer_ms",
            performance.now() - tRelayForward,
          );
          relayMetrics.responsesForwarded += 1;

          if (relayRoute.clientRequestId) {
            const idempotencyMap = getOrCreateRelayIdempotencyMap(relayRoute.conversationId);
            idempotencyMap.set(relayRoute.clientRequestId, {
              requestId: relayRoute.requestId,
              expiresAtMs: Date.now() + relayIdempotencyTtlMs,
              responseFrame,
            });
          }

          void recordSocketAuditEvent({
            eventType: socketEvents.relayRpcResponse,
            actorSocketId: socketId,
            direction: "agent_to_consumer",
            conversationId: relayRoute.conversationId,
            agentId: relayRoute.agentId,
            requestId: responseId,
            ...(streamId ? { streamId } : {}),
          });

          if (!streamId) {
            relayRoute.latencyTrace?.recordPendingResolveEnd();
            relayRoute.latencyTrace?.finalizeOnce({ outcome: "success" });
            const existingStream = getActiveStreamRouteByRequestId(responseId);
            if (existingStream && existingStream.agentSocketId === socketId) {
              removeActiveStreamRoute(existingStream);
            }
            removeRelayRequestRoute(responseId);
          }
        });
      } finally {
        fireAck();
      }
    });
  };

  const handleAgentRpcChunk = (socketId: string, rawPayload: unknown): void => {
    enqueueOrderedStreamInbound(socketId, async () => {
      const tDecode = performance.now();
      const result = await decodePayloadFrameAsync(rawPayload);
      observeRelayFrameDecode(performance.now() - tDecode);
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcChunk,
          socketId,
          reason: result.error.message,
        });
        failFastInvalidAgentStreamFrame(
          socketEvents.rpcChunk,
          socketId,
          rawPayload,
          result.error.message,
        );
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }

      const route = resolveActiveStreamRoute(socketId, data);
      if (!route) {
        return;
      }

      if (route.conversationId) {
        conversationRegistry.touchInternal(route.conversationId);
      }

      try {
        route.onChunk(data);
      } catch {
        logger.warn("rpc_stream_chunk_forward_failed", {
          requestId: route.requestId,
          streamId: route.streamId,
          socketId,
        });
      }
    });
  };

  const handleAgentRpcComplete = (socketId: string, rawPayload: unknown): void => {
    enqueueOrderedStreamInbound(socketId, async () => {
      const tDecode = performance.now();
      const result = await decodePayloadFrameAsync(rawPayload);
      observeRelayFrameDecode(performance.now() - tDecode);
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcComplete,
          socketId,
          reason: result.error.message,
        });
        failFastInvalidAgentStreamFrame(
          socketEvents.rpcComplete,
          socketId,
          rawPayload,
          result.error.message,
        );
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }

      const route = resolveActiveStreamRoute(socketId, data);
      if (!route) {
        return;
      }

      if (route.conversationId) {
        conversationRegistry.touchInternal(route.conversationId);
      }

      if (route.mode === "relay") {
        route.onComplete(data);
        return;
      }

      try {
        route.onComplete(data);
      } finally {
        removeActiveStreamRoute(route);
      }
    });
  };

  const handleAgentRpcAck = (socketId: string, rawPayload: unknown): void => {
    void decodePayloadFrameAsync(rawPayload).then((result) => {
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcRequestAck,
          socketId,
          reason: result.error.message,
        });
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }

      const requestId = toRequestId(data.request_id);
      if (!requestId) {
        return;
      }

      const pending = getRestPendingRequestByCorrelationId(requestId);
      if (pending && pending.socketId === socketId) {
        pending.acked = true;
        logger.debug("rpc_ack_received", { requestId, socketId });
      }

      const relayRoute = getRelayRequestRoute(requestId);
      if (relayRoute && relayRoute.agentSocketId === socketId) {
        enqueueRelayOutbound(requestId, async () => {
          const frame = await encodeRelayOutboundFrame(data, requestId);
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcRequestAck, frame);
        });
      }
    });
  };

  const handleAgentBatchAck = (socketId: string, rawPayload: unknown): void => {
    void decodePayloadFrameAsync(rawPayload).then((result) => {
      if (!result.ok) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcBatchAck,
          socketId,
          reason: result.error.message,
        });
        return;
      }

      const data = toRecord(result.value.data);
      if (!data) {
        return;
      }

      const requestIds = Array.isArray(data.request_ids)
        ? (data.request_ids as unknown[])
            .map((id) => toRequestId(id))
            .filter((id): id is string => id !== null)
        : [];

      const preencodedBatchAck = requestIds.length > 1 ? preencodePayloadFrameJson(data) : null;

      let ackedCount = 0;
      for (const requestId of requestIds) {
        const pending = getRestPendingRequestByCorrelationId(requestId);
        if (pending && pending.socketId === socketId) {
          pending.acked = true;
          ackedCount++;
        }

        const relayRoute = getRelayRequestRoute(requestId);
        if (relayRoute && relayRoute.agentSocketId === socketId) {
          enqueueRelayOutbound(requestId, async () => {
            const frame =
              preencodedBatchAck !== null
                ? finishPayloadFrameEnvelope(preencodedBatchAck, { requestId, omitTraceId: true })
                : await encodeRelayOutboundFrame(data, requestId);
            emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcBatchAck, frame);
          });
        }
      }
      if (ackedCount > 0) {
        logger.debug("rpc_batch_ack_received", {
          requestIds: requestIds.slice(0, 5),
          ackedCount,
          socketId,
        });
      }
    });
  };

  return {
    handleAgentRpcResponse,
    handleAgentRpcChunk,
    handleAgentRpcComplete,
    handleAgentRpcAck,
    handleAgentBatchAck,
  };
};
