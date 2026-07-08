import { recordSocketAuditEvent } from "../../../../application/services/socket_audit.service";
import { observeBridgeRpcMethod } from "../../../../application/services/bridge_rpc_method_metrics.service";
import { env } from "../../../../shared/config/env";
import { sampledMetricDelta } from "../../../../shared/metrics/metrics_sample";
import { socketEvents } from "../../../../shared/constants/socket_events";
import {
  observeRelayBufferDrain,
  observeRelayChunkForwardJob,
  relayMetrics,
} from "./bridge_relay_health_metrics";
import {
  getActiveStreamRouteByRequestId,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import {
  getRelayRequestRoute,
  removeRelayRequestRoute,
  type RelayRequestRoute,
} from "../registries/relay_request_registry";
import {
  drainRelayStreamBuffer,
  getRelayStreamFlowCredits,
  getRelayStreamBufferedChunkCount,
  getRelayStreamPendingComplete,
  clearRelayStreamFlowState,
  type DrainRelayStreamBufferContext,
} from "./relay_stream_flow_state";
import {
  enqueueRelayOutbound,
  encodeRelayOutboundFrame,
  encodeRelayOutboundFrameFromBytesAsync,
} from "./relay_outbound_queue";
import {
  isConsumerRelayTransportWritable,
  noteRelayStreamChunkEmitBackpressurePaused,
} from "./relay_consumer_transport_backpressure";
import { findConsumerBridgeSocketForRelay } from "./relay_consumer_socket_lookup";
import { trySettleRelayRoute } from "./relay_route_settlement";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";

const shouldAuditRelayChunks = env.socketAuditHighVolumeSamplePercent > 0;

export interface RelayStreamDrainRouteContext {
  readonly requestId: string;
  readonly consumerSocketId: string;
  readonly agentSocketId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly relayRoute?: RelayRequestRoute | null;
}

export interface ScheduleRelayStreamDrainInput {
  readonly route: RelayStreamDrainRouteContext;
  readonly emitToConsumer: EmitToConsumerFn;
  readonly isActive: () => boolean;
  readonly onComplete?: (streamId: string | null) => void;
  readonly getDrainScheduled: () => boolean;
  readonly setDrainScheduled: (value: boolean) => void;
  readonly reschedule: () => void;
}

const finalizeRelayStreamOnConsumerGone = (requestId: string): void => {
  const relayRoute = getRelayRequestRoute(requestId);
  if (relayRoute) {
    trySettleRelayRoute(relayRoute);
    removeRelayRequestRoute(requestId);
  }
  const activeRoute = getActiveStreamRouteByRequestId(requestId);
  if (activeRoute) {
    removeActiveStreamRoute(activeRoute);
  }
  clearRelayStreamFlowState(requestId);
};

const buildDrainContext = (
  route: RelayStreamDrainRouteContext,
  emitToConsumer: EmitToConsumerFn,
  isActive: () => boolean,
  onComplete?: (streamId: string | null) => void,
): DrainRelayStreamBufferContext => ({
  requestId: route.requestId,
  consumerSocketId: route.consumerSocketId,
  agentSocketId: route.agentSocketId,
  conversationId: route.conversationId,
  agentId: route.agentId,
  emitChunk: (frame: unknown) => {
    const consumerSocket = findConsumerBridgeSocketForRelay(route.consumerSocketId);
    if (consumerSocket && !isConsumerRelayTransportWritable(consumerSocket)) {
      noteRelayStreamChunkEmitBackpressurePaused();
      return false;
    }
    return emitToConsumer(route.consumerSocketId, socketEvents.relayRpcChunk, frame);
  },
  emitComplete: (frame: unknown) =>
    emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame),
  encodeFrame: (data: unknown) => encodeRelayOutboundFrame(data, route.requestId),
  encodeFrameFromBytes: (rawForward: { readonly bytes: Buffer; readonly cmp: "none" | "gzip" }) =>
    encodeRelayOutboundFrameFromBytesAsync(rawForward.bytes, route.requestId, {
      inboundCmp: rawForward.cmp,
    }),
  isActive,
  recordAudit: (eventType: string, extras?: Record<string, unknown>) => {
    if (!shouldAuditRelayChunks && eventType === socketEvents.relayRpcChunk) {
      return;
    }
    void recordSocketAuditEvent({
      eventType,
      actorSocketId: route.agentSocketId,
      direction: "agent_to_consumer",
      conversationId: route.conversationId,
      agentId: route.agentId,
      requestId: route.requestId,
      ...extras,
    });
  },
  onConsumerGone: finalizeRelayStreamOnConsumerGone,
  ...(onComplete !== undefined ? { onComplete } : {}),
});

/**
 * Central drain scheduling for relay streams (chunk handler and pull-triggered paths).
 */
export const scheduleRelayStreamDrain = (input: ScheduleRelayStreamDrainInput): void => {
  const {
    route,
    emitToConsumer,
    isActive,
    onComplete,
    getDrainScheduled,
    setDrainScheduled,
    reschedule,
  } = input;

  if (getDrainScheduled()) {
    return;
  }

  const creditsSnapshot = getRelayStreamFlowCredits(route.requestId);
  const bufferedChunkCount = getRelayStreamBufferedChunkCount(route.requestId);
  if (creditsSnapshot <= 0 || bufferedChunkCount === 0) {
    const pendingComplete = getRelayStreamPendingComplete(route.requestId);
    if (bufferedChunkCount === 0 && pendingComplete) {
      setDrainScheduled(true);
      enqueueRelayOutbound(route.requestId, async () => {
        const tDrain = performance.now();
        try {
          const result = await drainRelayStreamBuffer(
            buildDrainContext(route, emitToConsumer, isActive, onComplete),
          );
          if (result.chunksDrained > 0) {
            relayMetrics.chunksForwarded += sampledMetricDelta(result.chunksDrained);
            observeRelayChunkForwardJob(performance.now() - tDrain);
          }
        } finally {
          observeRelayBufferDrain(performance.now() - tDrain);
          setDrainScheduled(false);
          if (!isActive()) {
            return;
          }
          const pending = getRelayStreamPendingComplete(route.requestId);
          const hasBuffered = getRelayStreamBufferedChunkCount(route.requestId) > 0;
          const hasCredits = getRelayStreamFlowCredits(route.requestId) > 0;
          if ((hasBuffered && hasCredits) || (pending && !hasBuffered)) {
            reschedule();
          }
        }
      });
    }
    return;
  }

  setDrainScheduled(true);
  enqueueRelayOutbound(route.requestId, async () => {
    const tDrain = performance.now();
    try {
      const result = await drainRelayStreamBuffer(
        buildDrainContext(route, emitToConsumer, isActive, onComplete),
      );
      if (result.chunksDrained > 0) {
        relayMetrics.chunksForwarded += sampledMetricDelta(result.chunksDrained);
        observeRelayChunkForwardJob(performance.now() - tDrain);
      }
    } finally {
      observeRelayBufferDrain(performance.now() - tDrain);
      setDrainScheduled(false);
      if (!isActive()) {
        return;
      }
      const pending = getRelayStreamPendingComplete(route.requestId);
      const hasBuffered = getRelayStreamBufferedChunkCount(route.requestId) > 0;
      const hasCredits = getRelayStreamFlowCredits(route.requestId) > 0;
      if ((hasBuffered && hasCredits) || (pending && !hasBuffered)) {
        reschedule();
      }
    }
  });
};

export const buildRelayStreamPullDrainOnComplete = (
  requestId: string,
): ((streamId: string | null) => void) => {
  return (_streamId) => {
    const relayRt = getRelayRequestRoute(requestId);
    relayRt?.latencyTrace?.finalizeRelayStreamComplete();
    if (relayRt) {
      observeBridgeRpcMethod({
        channel: "relay",
        method: relayRt.jsonRpcMethod ?? "unknown",
        outcome: "success",
        elapsedMs: Date.now() - relayRt.createdAtMs,
      });
    }
    removeRelayRequestRoute(requestId);
    const activeRoute = getActiveStreamRouteByRequestId(requestId);
    if (activeRoute) {
      removeActiveStreamRoute(activeRoute);
    }
  };
};
