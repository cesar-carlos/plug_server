import { badRequest, notFound, serviceUnavailable } from "../../../../shared/errors/http_errors";
import { env } from "../../../../shared/config/env";
import { sampledMetricDelta } from "../../../../shared/metrics/metrics_sample";
import { socketEvents } from "../../../../shared/constants/socket_events";
import { encodePayloadFrameHotPath } from "../../../../shared/utils/payload_frame";
import { toRequestId } from "../../../../shared/utils/rpc_types";
import { agentRegistry } from "../registries/agent_registry";
import type { ActiveStreamRoute } from "../registries/active_stream_registry";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
  removeActiveStreamRoute,
} from "../registries/active_stream_registry";
import { registerAgentFailure, relayMetrics } from "./bridge_relay_health_metrics";
import { enqueueRelayOutbound, encodeRelayOutboundFrame } from "./relay_outbound_queue";
import {
  getRelayRequestRoute,
  removeRelayRequestRoute,
} from "../registries/relay_request_registry";
import { addRelayStreamFlowCredits, getRelayStreamForwardedRows } from "./relay_stream_flow_state";
import {
  buildRelayStreamPullDrainOnComplete,
  scheduleRelayStreamDrain,
} from "./relay_stream_drain_scheduler";
import { touchRelayStreamTimeout } from "../registries/relay_stream_timeout_registry";
import type { EmitToConsumerFn } from "./rpc_bridge_relay_stream";

const defaultStreamWindowSize = 1;

const clampStreamPullWindowToHubMax = (windowSize: number): number =>
  Math.min(
    Math.max(1, Math.floor(windowSize)),
    Math.max(1, Math.floor(env.socketRestStreamPullMaxWindowSize)),
  );

export interface RequestAgentStreamPullInput {
  readonly consumerSocketId: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly requestId?: string;
  readonly windowSize?: number;
}

export interface RequestAgentStreamPullResult {
  readonly requestId: string;
  readonly streamId: string;
  readonly windowSize: number;
}

type AgentSocketEmitter = {
  emit: (eventName: string, payload: unknown) => void;
};

export interface RpcBridgeStreamPullDeps {
  readonly hasRegisteredAgentSocketBridge: () => boolean;
  readonly findAgentSocketById: (socketId: string) => AgentSocketEmitter | null;
  readonly emitToConsumer: EmitToConsumerFn;
}

/**
 * Side-effect-free preview of an `agents:stream_pull` request.
 * Resolves the route and computes the effective `windowSize` so callers can apply
 * quotas / rate limits before invoking `execute()`, which actually emits to the
 * agent and (for relay routes) grants flow credits.
 */
export interface PreparedAgentStreamPull {
  readonly requestId: string;
  readonly streamId: string;
  readonly windowSize: number;
  readonly execute: () => RequestAgentStreamPullResult;
}

export const createPrepareAgentStreamPull = (
  deps: RpcBridgeStreamPullDeps,
): ((input: RequestAgentStreamPullInput) => PreparedAgentStreamPull) => {
  const { hasRegisteredAgentSocketBridge, findAgentSocketById, emitToConsumer } = deps;

  const cleanupMissingAgentSocketRoute = (route: ActiveStreamRoute): void => {
    const relayRoute = getRelayRequestRoute(route.requestId);
    const agentId =
      relayRoute?.agentId ??
      route.restMaterializeState?.agentId ??
      agentRegistry.findBySocketId(route.agentSocketId)?.agentId;
    if (agentId) {
      registerAgentFailure(agentId);
    }

    if (route.mode === "relay") {
      const forwardedRows = getRelayStreamForwardedRows(route.requestId);
      const streamId = route.streamId;
      removeRelayRequestRoute(route.requestId);
      removeActiveStreamRoute(route, { restMaterialize: "detach" });
      enqueueRelayOutbound(route.requestId, async () => {
        const frame = await encodeRelayOutboundFrame(
          {
            request_id: route.requestId,
            total_rows: forwardedRows,
            terminal_status: "error",
            ...(streamId ? { stream_id: streamId } : {}),
          },
          route.requestId,
        );
        emitToConsumer(route.consumerSocketId, socketEvents.relayRpcComplete, frame);
      });
      return;
    }

    removeActiveStreamRoute(route);
  };

  return (input: RequestAgentStreamPullInput): PreparedAgentStreamPull => {
    const resolvedRequestId = input.requestId ? toRequestId(input.requestId) : null;
    const resolvedStreamId = input.streamId ? toRequestId(input.streamId) : null;
    if (!resolvedRequestId && !resolvedStreamId) {
      throw badRequest("Provide streamId or requestId to pull stream chunks");
    }

    const routeByStreamId = resolvedStreamId
      ? getActiveStreamRouteByStreamId(resolvedStreamId)
      : undefined;
    const routeByRequestId = resolvedRequestId
      ? getActiveStreamRouteByRequestId(resolvedRequestId)
      : undefined;
    if (routeByStreamId && routeByRequestId && routeByStreamId !== routeByRequestId) {
      throw badRequest("streamId and requestId refer to different stream routes");
    }

    const route = routeByStreamId ?? routeByRequestId;

    if (!route) {
      throw notFound("Stream route");
    }

    if (route.consumerSocketId !== input.consumerSocketId) {
      throw notFound("Stream route");
    }

    if (input.conversationId && route.conversationId !== input.conversationId) {
      throw notFound("Stream route");
    }

    const streamId = resolvedStreamId ?? route.streamId;
    if (!streamId) {
      throw badRequest("Stream id is not available yet for this request");
    }

    if (!hasRegisteredAgentSocketBridge()) {
      throw serviceUnavailable("Socket bridge is not initialized");
    }

    const agentSocket = findAgentSocketById(route.agentSocketId);
    if (!agentSocket) {
      cleanupMissingAgentSocketRoute(route);
      throw serviceUnavailable("Agent socket is unavailable");
    }

    const registeredAgent = agentRegistry.findBySocketId(route.agentSocketId);
    const windowSize = registeredAgent
      ? agentRegistry.resolveStreamPullWindow(
          registeredAgent.agentId,
          defaultStreamWindowSize,
          input.windowSize,
        )
      : typeof input.windowSize === "number" && Number.isFinite(input.windowSize)
        ? clampStreamPullWindowToHubMax(input.windowSize)
        : clampStreamPullWindowToHubMax(defaultStreamWindowSize);

    const execute = (): RequestAgentStreamPullResult => {
      agentSocket.emit(
        socketEvents.rpcStreamPull,
        encodePayloadFrameHotPath(
          {
            stream_id: streamId,
            request_id: route.requestId,
            window_size: windowSize,
          },
          { requestId: route.requestId },
        ),
      );

      if (route.mode === "relay") {
        relayMetrics.streamPulls += sampledMetricDelta(1);
        touchRelayStreamTimeout(route.requestId);
        const relayRouteForAudit = getRelayRequestRoute(route.requestId);
        addRelayStreamFlowCredits(route.requestId, windowSize);

        let pullDrainScheduled = false;
        const schedulePullDrain = (): void => {
          scheduleRelayStreamDrain({
            route: {
              requestId: route.requestId,
              consumerSocketId: route.consumerSocketId,
              agentSocketId: route.agentSocketId,
              conversationId: relayRouteForAudit?.conversationId ?? "",
              agentId: relayRouteForAudit?.agentId ?? "",
              relayRoute: relayRouteForAudit ?? null,
            },
            emitToConsumer,
            isActive: () => {
              const activeRoute = getActiveStreamRouteByRequestId(route.requestId);
              const relayRoute = getRelayRequestRoute(route.requestId);
              return (
                activeRoute === route &&
                Boolean(
                  relayRoute &&
                  relayRoute.consumerSocketId === route.consumerSocketId &&
                  relayRoute.agentSocketId === route.agentSocketId,
                )
              );
            },
            onComplete: buildRelayStreamPullDrainOnComplete(route.requestId),
            getDrainScheduled: () => pullDrainScheduled,
            setDrainScheduled: (value) => {
              pullDrainScheduled = value;
            },
            reschedule: schedulePullDrain,
          });
        };
        schedulePullDrain();
      }

      return {
        requestId: route.requestId,
        streamId,
        windowSize,
      };
    };

    return {
      requestId: route.requestId,
      streamId,
      windowSize,
      execute,
    };
  };
};

export const createRequestAgentStreamPull = (
  deps: RpcBridgeStreamPullDeps,
): ((input: RequestAgentStreamPullInput) => RequestAgentStreamPullResult) => {
  const prepare = createPrepareAgentStreamPull(deps);
  return (input: RequestAgentStreamPullInput): RequestAgentStreamPullResult => {
    return prepare(input).execute();
  };
};
