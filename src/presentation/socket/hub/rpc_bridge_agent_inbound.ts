import { mergeSqlStreamRpcResponse } from "../../../application/agent_commands/merge_sql_stream_rpc_response";
import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { logger } from "../../../shared/utils/logger";
import {
  decodePayloadFrame,
  decodePayloadFrameAsync,
  encodePayloadFrame,
  finishPayloadFrameEnvelope,
  preencodePayloadFrameJson,
} from "../../../shared/utils/payload_frame";
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
  observeAgentLatency,
  registerAgentSuccess,
  relayMetrics,
} from "./bridge_relay_health_metrics";
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
import { relayStreamFlowState } from "./relay_stream_flow_state";
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
            const chunkBuffer: Record<string, unknown>[] = [];
            const pullWindow = env.socketRestStreamPullWindowSize;

            const streamHandlers: StreamEventHandlers = {
              consumerSocketId: REST_STREAM_AGGREGATE_CONSUMER_ID,
              mode: "legacy",
              onChunk: (payload) => {
                chunkBuffer.push(payload);
                restSqlStreamMaterializeConsumeChunk(primaryRequestId, pullWindow, () => {
                  const route = getActiveStreamRouteByRequestId(primaryRequestId);
                  if (route) {
                    emitRpcStreamPullForRoute(route, pullWindow);
                  }
                });
              },
              onComplete: (payload) => {
                clearTimeout(timeoutHandle);
                try {
                  const merged = mergeSqlStreamRpcResponse(initialJson, chunkBuffer, payload);
                  pendingRequest.latencyTrace?.recordPendingResolveEnd();
                  resolveOnce(merged);
                } catch (err) {
                  rejectOnce(err instanceof Error ? err : new Error("Failed to merge SQL stream"));
                }
              },
            };

            upsertActiveStreamRoute({
              requestId: primaryRequestId,
              agentSocketId: socketId,
              streamHandlers,
              streamId: streamId as string,
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

        const responseFrame = encodePayloadFrame(decoded.data, {
          requestId: responseId,
          omitTraceId: true,
        });
        const tRelayForward = performance.now();
        emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcResponse, responseFrame);
        relayRoute.latencyTrace?.addPhaseMs(
          "relay_forward_to_consumer_ms",
          performance.now() - tRelayForward,
        );
        relayMetrics.responsesForwarded += 1;
        observeAgentLatency(relayRoute.agentId, Date.now() - relayRoute.createdAtMs);
        registerAgentSuccess(relayRoute.agentId);
        clearTimeout(relayRoute.timeoutHandle);
        conversationRegistry.touch(relayRoute.conversationId);

        if (relayRoute.clientRequestId) {
          const idempotencyMap = getOrCreateRelayIdempotencyMap(relayRoute.conversationId);
          idempotencyMap.set(relayRoute.clientRequestId, {
            requestId: relayRoute.requestId,
            expiresAtMs: Date.now() + relayIdempotencyTtlMs,
            responseFrame,
          });
        }

        if (streamId) {
          relayRoute.latencyTrace?.markRelayStreamOpenWall();
          upsertActiveStreamRoute({
            requestId: responseId,
            agentSocketId: socketId,
            streamHandlers: createRelayStreamHandlers(relayRoute, emitToConsumer),
            streamId,
          });
          relayStreamFlowState.creditsByRequestId.set(responseId, 0);
        } else {
          relayRoute.latencyTrace?.recordPendingResolveEnd();
          relayRoute.latencyTrace?.finalizeOnce({ outcome: "success" });
          const existingStream = getActiveStreamRouteByRequestId(responseId);
          if (existingStream && existingStream.agentSocketId === socketId) {
            removeActiveStreamRoute(existingStream);
          }
          removeRelayRequestRoute(responseId);
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
      } finally {
        fireAck();
      }
    });
  };

  const handleAgentRpcChunk = (socketId: string, rawPayload: unknown): void => {
    /** Sync decode preserves chunk ordering per socket (async gunzip could reorder under load). */
    const result = decodePayloadFrame(rawPayload);
    if (!result.ok) {
      logRpcFrameDecodeFailure({
        eventName: socketEvents.rpcChunk,
        socketId,
        reason: result.error.message,
      });
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
      conversationRegistry.touch(route.conversationId);
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
  };

  const handleAgentRpcComplete = (socketId: string, rawPayload: unknown): void => {
    const result = decodePayloadFrame(rawPayload);
    if (!result.ok) {
      logRpcFrameDecodeFailure({
        eventName: socketEvents.rpcComplete,
        socketId,
        reason: result.error.message,
      });
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
      conversationRegistry.touch(route.conversationId);
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
        emitToConsumer(
          relayRoute.consumerSocketId,
          socketEvents.relayRpcRequestAck,
          encodePayloadFrame(data, { requestId, omitTraceId: true }),
        );
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
          const frame =
            preencodedBatchAck !== null
              ? finishPayloadFrameEnvelope(preencodedBatchAck, { requestId, omitTraceId: true })
              : encodePayloadFrame(data, { requestId, omitTraceId: true });
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcBatchAck, frame);
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
