import { HUB_MAX_BATCH_SIZE } from "../../../../shared/constants/agent_transport_contract";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { serviceUnavailable } from "../../../../shared/errors/http_errors";
import { logger } from "../../../../shared/utils/logger";
import {
  decodePayloadFrameAsync,
  type DecodedPayloadFrame,
} from "../../../../shared/utils/payload_frame";
import {
  enqueueRelayOutbound,
  encodeRelayOutboundFrame,
  encodeRelayOutboundFrameFromBytesAsync,
  encodeRelayOutboundFrameFromPreencodedWireAsync,
  markRelayOutboundForceGzip,
} from "./relay_outbound_queue";
import { isRecord, toRequestId } from "../../../../shared/utils/rpc_types";
import type { ActiveStreamRoute } from "../registries/active_stream_registry";
import {
  countOpenStreamRoutesForAgent,
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
  resolveActiveStreamRoute,
  upsertActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  logRpcFrameDecodeFailure,
  observeRelayFrameDecode,
  observeAgentLatency,
  registerAgentFailure,
  registerAgentSuccess,
} from "./bridge_relay_health_metrics";
import { agentRegistry } from "../registries/agent_registry";
import { validateAgentInboundContract } from "../handshake/agent_inbound_contract_validation";
import { conversationRegistry } from "../registries/conversation_registry";
import {
  clearRestPendingRequest,
  findRestPendingRequestByIds,
  getRestPendingRequestByCorrelationId,
} from "../registries/rest_pending_requests";
import { streamChunkMetadataFromPayloadFrame } from "./stream_chunk_metadata";
import { getRelayRequestRoute } from "../registries/relay_request_registry";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";
import { extractStreamIdFromRpcResponse, pickResponseIds } from "./rpc_bridge_command_helpers";
import {
  admitAgentInboundFrameSeq,
  cleanupAgentInboundSequencerSocket,
  completeAgentInboundCommitTurn,
  isAgentInboundTicketCurrent,
  noteAgentInboundChunkWithoutRoute,
  resetAgentInboundSequencerForTests,
  waitAgentInboundCommitTurn,
} from "./agent_inbound_sequencer";
import {
  admitAgentInboundFrame,
  cleanupAgentInboundIngressSocket,
  resetAgentInboundIngressForTests,
  type AgentInboundGuardEvent,
} from "./agent_inbound_ingress_guard";
import type { RelayChunkRawForward } from "./relay_stream_flow_state";
import { forwardRelayRouteResponse } from "./relay_route_response_forwarder";
import { startRestStreamMaterialization } from "./rest_stream_materialize_handler";
import { createRelayFailFastEmitters } from "./rpc_bridge_relay_fail_fast";

const toRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export interface RpcBridgeAgentInboundDeps {
  readonly emitToConsumer: EmitToConsumerFn;
  readonly emitRpcStreamPullForRoute: (route: ActiveStreamRoute, windowSize: number) => void;
  /** Test seam: delay or wrap decode to force commit-order races. */
  readonly decodePayloadFrameAsync?: typeof decodePayloadFrameAsync;
  readonly disconnectAgentSocket?: (socketId: string) => void;
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
  readonly cleanupSocketInboundState: (socketId: string) => void;
  readonly resetInboundState: () => void;
};

export const createRpcBridgeAgentInboundHandlers = (
  deps: RpcBridgeAgentInboundDeps,
): RpcBridgeAgentInboundHandlers => {
  const { emitToConsumer, emitRpcStreamPullForRoute } = deps;
  const decodeFrame = deps.decodePayloadFrameAsync ?? decodePayloadFrameAsync;

  const admitOrDrop = (
    socketId: string,
    event: AgentInboundGuardEvent,
    rawPayload: unknown,
  ): { readonly admitted: true; readonly release: () => void } | null => {
    const decision = admitAgentInboundFrame({ socketId, event, rawPayload });
    if (!decision.admitted) {
      if (decision.disconnect) {
        deps.disconnectAgentSocket?.(socketId);
      }
      return null;
    }
    return decision;
  };

  const {
    failFastUnexpectedAgentResponseError,
    failFastInvalidAgentResponseFrame,
    failFastInvalidAgentStreamFrame,
    rejectRelayBatchResponse,
  } = createRelayFailFastEmitters({ emitToConsumer });

  const runSequencedInbound = (
    socketId: string,
    event: AgentInboundGuardEvent,
    rawPayload: unknown,
    decodeThenCommit: () => Promise<(() => void | Promise<void>) | null>,
    onDecoded?: () => void,
  ): void => {
    const admission = admitOrDrop(socketId, event, rawPayload);
    if (!admission) {
      if (event === socketEvents.rpcResponse) {
        failFastInvalidAgentResponseFrame(socketId, rawPayload, "inbound ingress limit");
      } else if (event === socketEvents.rpcChunk || event === socketEvents.rpcComplete) {
        failFastInvalidAgentStreamFrame(event, socketId, rawPayload, "inbound ingress limit");
      }
      return;
    }
    const ticket = admitAgentInboundFrameSeq(socketId);
    void (async () => {
      let commit: (() => void | Promise<void>) | null = null;
      try {
        commit = await decodeThenCommit();
      } catch (error: unknown) {
        commit = () => {
          if (event === socketEvents.rpcResponse) {
            failFastUnexpectedAgentResponseError(socketId, rawPayload, error);
            return;
          }
          const reason = error instanceof Error ? error.message : "inbound decode failed";
          failFastInvalidAgentStreamFrame(event, socketId, rawPayload, reason);
        };
      }
      // Preserve the transport ACK for rejected frames, but never acknowledge
      // before the decode/signature/contract decision has completed.
      onDecoded?.();
      const turn = await waitAgentInboundCommitTurn(ticket);
      try {
        if (turn === "live" && commit !== null && isAgentInboundTicketCurrent(ticket)) {
          await commit();
        }
      } catch (error: unknown) {
        if (event === socketEvents.rpcResponse) {
          failFastUnexpectedAgentResponseError(socketId, rawPayload, error);
        } else {
          logger.warn("rpc_inbound_commit_failed", {
            socketId,
            event,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      } finally {
        if (turn === "live") {
          completeAgentInboundCommitTurn(ticket);
        }
        admission.release();
      }
    })();
  };

  const handleAgentRpcResponse = (
    socketId: string,
    rawPayload: unknown,
    ack?: () => void,
  ): void => {
    const inboundSyncStart = performance.now();
    const decodeStart = inboundSyncStart;
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

    runSequencedInbound(
      socketId,
      socketEvents.rpcResponse,
      rawPayload,
      async () => {
        try {
          const result = await decodeFrame(rawPayload);
          const decodeMs = performance.now() - decodeStart;

          if (!result.ok) {
            logRpcFrameDecodeFailure({
              eventName: socketEvents.rpcResponse,
              socketId,
              reason: result.error.message,
            });
            return () => {
              failFastInvalidAgentResponseFrame(socketId, rawPayload, result.error.message);
            };
          }

          const decoded = result.value;
          const contractValidation = validateAgentInboundContract({
            eventName: socketEvents.rpcResponse,
            payload: decoded.data,
            socketId,
          });
          if (!contractValidation.shouldProcess) {
            const reason = `Inbound contract invalid: ${contractValidation.message}`;
            logRpcFrameDecodeFailure({
              eventName: socketEvents.rpcResponse,
              socketId,
              reason,
            });
            return () => {
              failFastInvalidAgentResponseFrame(socketId, rawPayload, reason);
            };
          }

          if (Array.isArray(decoded.data) && decoded.data.length > HUB_MAX_BATCH_SIZE) {
            const reason = `rpc:response batch cannot exceed ${HUB_MAX_BATCH_SIZE}`;
            logRpcFrameDecodeFailure({
              eventName: socketEvents.rpcResponse,
              socketId,
              reason,
            });
            return () => {
              failFastInvalidAgentResponseFrame(socketId, rawPayload, reason);
            };
          }

          return () => {
            const frameRequestId = toRequestId(decoded.frame.requestId);
            const responseIds = pickResponseIds(decoded.data);
            let candidateIds: readonly string[];
            if (frameRequestId === null) {
              candidateIds = responseIds;
            } else if (responseIds.length === 0) {
              candidateIds = [frameRequestId];
            } else if (responseIds.length === 1 && responseIds[0] === frameRequestId) {
              candidateIds = responseIds;
            } else {
              const idSet = new Set(responseIds);
              idSet.add(frameRequestId);
              candidateIds = Array.from(idSet);
            }

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
                startRestStreamMaterialization({
                  socketId,
                  pendingRequest,
                  decoded,
                  streamId: streamId as string,
                  emitRpcStreamPullForRoute,
                });
                return;
              }

              if (pendingRequest.streamHandlers) {
                if (streamId) {
                  const effectivePolicy = agentRegistry.resolveEffectiveDispatchPolicy(
                    pendingRequest.agentId,
                  );
                  if (
                    countOpenStreamRoutesForAgent(socketId) >= effectivePolicy.maxConcurrentStreams
                  ) {
                    registerAgentFailure(pendingRequest.agentId, "rest");
                    clearTimeout(pendingRequest.timeoutHandle);
                    clearRestPendingRequest(pendingRequest);
                    pendingRequest.reject(
                      serviceUnavailable(
                        `Agent active stream capacity reached (${effectivePolicy.maxConcurrentStreams})`,
                      ),
                    );
                    return;
                  }
                  upsertActiveStreamRoute({
                    requestId: pendingRequestId,
                    agentSocketId: socketId,
                    agentId: pendingRequest.agentId,
                    streamHandlers: pendingRequest.streamHandlers,
                    streamId,
                  });
                  if (logger.isLevelEnabled("debug")) {
                    logger.debug("rpc_stream_registered", {
                      requestId: pendingRequestId,
                      streamId,
                      socketId,
                    });
                  }
                } else {
                  const existingStream = getActiveStreamRouteByRequestId(pendingRequestId);
                  if (existingStream && existingStream.agentSocketId === socketId) {
                    removeActiveStreamRoute(existingStream);
                  }
                }
              }

              if (!pendingRequest.acked) {
                if (logger.isLevelEnabled("debug")) {
                  logger.debug("rpc_response_received_without_ack", {
                    requestId: pendingRequestId,
                    socketId,
                  });
                }
              }

              registerAgentSuccess(pendingRequest.agentId, "rest");
              observeAgentLatency(pendingRequest.agentId, Date.now() - pendingRequest.createdAtMs);
              clearTimeout(pendingRequest.timeoutHandle);
              clearRestPendingRequest(pendingRequest);
              pendingRequest.latencyTrace?.recordPendingResolveEnd();
              pendingRequest.resolve(decoded.data);
            }

            if (Array.isArray(decoded.data)) {
              if (rejectRelayBatchResponse(socketId, candidateIds, inboundSyncStart, decodeMs)) {
                return;
              }
            }

            forwardRelayRouteResponse({
              socketId,
              candidateIds,
              decoded,
              streamId,
              inboundSyncStart,
              decodeMs,
              emitToConsumer,
            });
          };
        } catch (error: unknown) {
          return () => {
            failFastUnexpectedAgentResponseError(socketId, rawPayload, error);
          };
        }
      },
      fireAck,
    );
  };

  /**
   * Decode and validate stream frames without resolving the route. Route lookup
   * happens in the sequenced commit so a delayed `rpc:response` gunzip cannot
   * drop a later `rpc:chunk` that arrived first.
   */
  const decodeValidatedStreamFrame = async (
    eventName: Parameters<typeof validateAgentInboundContract>[0]["eventName"],
    socketId: string,
    rawPayload: unknown,
  ): Promise<
    | {
        readonly ok: true;
        readonly data: Record<string, unknown>;
        readonly frame: DecodedPayloadFrame["frame"];
        readonly decodedBytes: Buffer;
      }
    | { readonly ok: false; readonly reason: string }
    | null
  > => {
    const tDecode = performance.now();
    const result = await decodeFrame(rawPayload);
    observeRelayFrameDecode(performance.now() - tDecode);
    if (!result.ok) {
      logRpcFrameDecodeFailure({ eventName, socketId, reason: result.error.message });
      return { ok: false, reason: result.error.message };
    }

    const contractValidation = validateAgentInboundContract({
      eventName,
      payload: result.value.data,
      socketId,
    });
    if (!contractValidation.shouldProcess) {
      const reason = `Inbound contract invalid: ${contractValidation.message}`;
      logRpcFrameDecodeFailure({ eventName, socketId, reason });
      return { ok: false, reason };
    }

    const data = toRecord(result.value.data);
    if (!data) {
      return null;
    }
    if (result.value.frame.cmp === "gzip") {
      markRelayOutboundForceGzip(data);
    }

    return { ok: true, data, frame: result.value.frame, decodedBytes: result.value.decodedBytes };
  };

  const resolveLiveStreamRoute = (
    socketId: string,
    data: Record<string, unknown>,
    options?: { readonly noteMissingRoute?: boolean },
  ): ActiveStreamRoute | null => {
    const route = resolveActiveStreamRoute(socketId, data);
    if (!route) {
      if (options?.noteMissingRoute === true) {
        noteAgentInboundChunkWithoutRoute();
      }
      return null;
    }
    const liveRoute = getActiveStreamRouteByRequestId(route.requestId);
    if (!liveRoute || liveRoute !== route) {
      return null;
    }
    if (route.conversationId) {
      conversationRegistry.touchInternalDebounced(route.conversationId);
    }
    return liveRoute;
  };

  const handleAgentRpcChunk = (socketId: string, rawPayload: unknown): void => {
    runSequencedInbound(socketId, socketEvents.rpcChunk, rawPayload, async () => {
      const decoded = await decodeValidatedStreamFrame(socketEvents.rpcChunk, socketId, rawPayload);
      if (decoded === null) {
        return null;
      }
      if (!decoded.ok) {
        return () => {
          failFastInvalidAgentStreamFrame(
            socketEvents.rpcChunk,
            socketId,
            rawPayload,
            decoded.reason,
          );
        };
      }
      return () => {
        const route = resolveLiveStreamRoute(socketId, decoded.data, { noteMissingRoute: true });
        if (!route) {
          return;
        }
        try {
          route.onChunk(decoded.data, streamChunkMetadataFromPayloadFrame(decoded.frame), {
            bytes: decoded.decodedBytes,
            cmp: decoded.frame.cmp,
            ...(decoded.frame.cmp === "gzip" && Buffer.isBuffer(decoded.frame.payload)
              ? {
                  wireBytes: decoded.frame.payload,
                  originalSize: decoded.frame.originalSize,
                }
              : {}),
          });
        } catch {
          logger.warn("rpc_stream_chunk_forward_failed", {
            requestId: route.requestId,
            streamId: route.streamId,
            socketId,
          });
        }
      };
    });
  };

  const handleAgentRpcComplete = (socketId: string, rawPayload: unknown): void => {
    runSequencedInbound(socketId, socketEvents.rpcComplete, rawPayload, async () => {
      const decoded = await decodeValidatedStreamFrame(
        socketEvents.rpcComplete,
        socketId,
        rawPayload,
      );
      if (decoded === null) {
        return null;
      }
      if (!decoded.ok) {
        return () => {
          failFastInvalidAgentStreamFrame(
            socketEvents.rpcComplete,
            socketId,
            rawPayload,
            decoded.reason,
          );
        };
      }
      return () => {
        const route = resolveLiveStreamRoute(socketId, decoded.data);
        if (!route) {
          return;
        }

        const completeRawForward: RelayChunkRawForward = {
          bytes: decoded.decodedBytes,
          cmp: decoded.frame.cmp,
          ...(decoded.frame.cmp === "gzip" && Buffer.isBuffer(decoded.frame.payload)
            ? {
                wireBytes: decoded.frame.payload,
                originalSize: decoded.frame.originalSize,
              }
            : {}),
        };

        if (route.mode === "relay") {
          route.onComplete(decoded.data, completeRawForward);
          return;
        }

        try {
          route.onComplete(decoded.data);
        } finally {
          removeActiveStreamRoute(route);
        }
      };
    });
  };

  interface DecodedAckFrame {
    readonly data: Record<string, unknown>;
    readonly decodedBytes: Buffer;
    readonly inboundCmp: "none" | "gzip";
    readonly wireBytes?: Buffer;
    readonly originalSize?: number;
  }

  /**
   * Shared preamble for the ack handlers (`rpc:request_ack` / `rpc:batch_ack`):
   * decode the frame, validate the inbound contract and normalize to a record.
   * Unlike the stream preamble it does not fail-fast or resolve a stream route —
   * a bad ack frame is logged and dropped. Returns `null` on any short-circuit.
   */
  const decodeAndValidateAckFrame = async (
    eventName: Parameters<typeof validateAgentInboundContract>[0]["eventName"],
    socketId: string,
    rawPayload: unknown,
  ): Promise<DecodedAckFrame | null> => {
    const result = await decodeFrame(rawPayload);
    if (!result.ok) {
      logRpcFrameDecodeFailure({ eventName, socketId, reason: result.error.message });
      return null;
    }

    const contractValidation = validateAgentInboundContract({
      eventName,
      payload: result.value.data,
      socketId,
    });
    if (!contractValidation.shouldProcess) {
      logRpcFrameDecodeFailure({
        eventName,
        socketId,
        reason: `Inbound contract invalid: ${contractValidation.message}`,
      });
      return null;
    }

    const data = toRecord(result.value.data);
    if (!data) {
      return null;
    }

    return {
      data,
      decodedBytes: result.value.decodedBytes,
      inboundCmp: result.value.frame.cmp,
      ...(result.value.frame.cmp === "gzip" && Buffer.isBuffer(result.value.frame.payload)
        ? {
            wireBytes: result.value.frame.payload,
            originalSize: result.value.frame.originalSize,
          }
        : {}),
    };
  };

  const handleAgentRpcAck = (socketId: string, rawPayload: unknown): void => {
    const admission = admitOrDrop(socketId, socketEvents.rpcRequestAck, rawPayload);
    if (!admission) {
      return;
    }
    void (async () => {
      const ackFrame = await decodeAndValidateAckFrame(
        socketEvents.rpcRequestAck,
        socketId,
        rawPayload,
      );
      if (!ackFrame) {
        return;
      }
      const { data, decodedBytes, inboundCmp, wireBytes, originalSize } = ackFrame;

      const requestId = toRequestId(data.request_id);
      if (!requestId) {
        return;
      }

      const pending = getRestPendingRequestByCorrelationId(requestId);
      if (pending && pending.socketId === socketId) {
        pending.acked = true;
        if (pending.ackRetryTimer !== undefined) {
          clearTimeout(pending.ackRetryTimer);
          delete pending.ackRetryTimer;
        }
        if (logger.isLevelEnabled("debug")) {
          logger.debug("rpc_ack_received", { requestId, socketId });
        }
      }

      const relayRoute = getRelayRequestRoute(requestId);
      if (relayRoute && relayRoute.agentSocketId === socketId) {
        relayRoute.acked = true;
        if (relayRoute.ackRetryTimer !== undefined) {
          clearTimeout(relayRoute.ackRetryTimer);
          delete relayRoute.ackRetryTimer;
        }
        enqueueRelayOutbound(requestId, async () => {
          const frame =
            wireBytes !== undefined && originalSize !== undefined
              ? await encodeRelayOutboundFrameFromPreencodedWireAsync(
                  { originalSize, wireBytes, cmp: inboundCmp },
                  requestId,
                )
              : await encodeRelayOutboundFrameFromBytesAsync(decodedBytes, requestId, {
                  inboundCmp,
                });
          emitToConsumer(relayRoute.consumerSocketId, socketEvents.relayRpcRequestAck, frame);
        });
      }
    })()
      .catch((error: unknown) => {
        logger.warn("rpc_ack_handler_failed", {
          socketId,
          eventName: socketEvents.rpcRequestAck,
          message: error instanceof Error ? error.message : "unknown error",
        });
      })
      .finally(() => {
        admission.release();
      });
  };

  const handleAgentBatchAck = (socketId: string, rawPayload: unknown): void => {
    const admission = admitOrDrop(socketId, socketEvents.rpcBatchAck, rawPayload);
    if (!admission) {
      return;
    }
    void (async () => {
      const ackFrame = await decodeAndValidateAckFrame(
        socketEvents.rpcBatchAck,
        socketId,
        rawPayload,
      );
      if (!ackFrame) {
        return;
      }
      const { data } = ackFrame;
      if (Array.isArray(data.request_ids) && data.request_ids.length > HUB_MAX_BATCH_SIZE) {
        logRpcFrameDecodeFailure({
          eventName: socketEvents.rpcBatchAck,
          socketId,
          reason: `rpc:batch_ack request_ids cannot exceed ${HUB_MAX_BATCH_SIZE}`,
        });
        return;
      }

      // Single-pass dedup: replaces .map().filter().Set().Array.from()
      // (four intermediate allocations) with one loop + one Set.
      const requestIds: string[] = [];
      if (Array.isArray(data.request_ids)) {
        const seenIds = new Set<string>();
        for (const rawId of data.request_ids as unknown[]) {
          const resolved = toRequestId(rawId);
          if (resolved !== null && !seenIds.has(resolved)) {
            seenIds.add(resolved);
            requestIds.push(resolved);
          }
        }
      }

      let ackedCount = 0;
      const relayBatchAckByConsumer = new Map<
        string,
        { firstRequestId: string; requestIds: string[] }
      >();
      for (const requestId of requestIds) {
        const pending = getRestPendingRequestByCorrelationId(requestId);
        if (pending && pending.socketId === socketId) {
          pending.acked = true;
          if (pending.ackRetryTimer !== undefined) {
            clearTimeout(pending.ackRetryTimer);
            delete pending.ackRetryTimer;
          }
          ackedCount++;
        }

        const relayRoute = getRelayRequestRoute(requestId);
        if (relayRoute && relayRoute.agentSocketId === socketId) {
          relayRoute.acked = true;
          if (relayRoute.ackRetryTimer !== undefined) {
            clearTimeout(relayRoute.ackRetryTimer);
            delete relayRoute.ackRetryTimer;
          }
          ackedCount++;
          const existing = relayBatchAckByConsumer.get(relayRoute.consumerSocketId);
          if (existing) {
            existing.requestIds.push(requestId);
          } else {
            relayBatchAckByConsumer.set(relayRoute.consumerSocketId, {
              firstRequestId: requestId,
              requestIds: [requestId],
            });
          }
        }
      }
      for (const [consumerSocketId, batch] of relayBatchAckByConsumer.entries()) {
        enqueueRelayOutbound(batch.firstRequestId, async () => {
          const relayBatchAckPayload = {
            request_ids: batch.requestIds,
            ...(typeof data.received_at === "string" ? { received_at: data.received_at } : {}),
          };
          const frame = await encodeRelayOutboundFrame(relayBatchAckPayload, batch.firstRequestId);
          emitToConsumer(consumerSocketId, socketEvents.relayRpcBatchAck, frame);
        });
      }
      if (ackedCount > 0 && logger.isLevelEnabled("debug")) {
        logger.debug("rpc_batch_ack_received", {
          requestIds: requestIds.slice(0, 5),
          ackedCount,
          socketId,
        });
      }
    })()
      .catch((error: unknown) => {
        logger.warn("rpc_ack_handler_failed", {
          socketId,
          eventName: socketEvents.rpcBatchAck,
          message: error instanceof Error ? error.message : "unknown error",
        });
      })
      .finally(() => {
        admission.release();
      });
  };

  return {
    handleAgentRpcResponse,
    handleAgentRpcChunk,
    handleAgentRpcComplete,
    handleAgentRpcAck,
    handleAgentBatchAck,
    cleanupSocketInboundState: (socketId: string): void => {
      cleanupAgentInboundSequencerSocket(socketId);
      cleanupAgentInboundIngressSocket(socketId);
    },
    resetInboundState: (): void => {
      resetAgentInboundSequencerForTests();
      resetAgentInboundIngressForTests();
    },
  };
};
