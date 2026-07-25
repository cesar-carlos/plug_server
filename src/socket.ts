import type { Server as HttpServer } from "node:http";

import { Server } from "socket.io";

import { registerAgentProfileBroadcastHandler } from "./application/services/agent_profile_broadcast_sink";
import { registerAgentSocketControlHandler } from "./application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "./application/services/consumer_socket_control_sink";
import { registerConsumerSocketEventHandler } from "./application/services/consumer_socket_event_sink";
import { buildConsumerSocketControlHandlers } from "./presentation/socket/hub/build_consumer_socket_control_handlers";
import { buildConsumerSocketPublishHandler } from "./presentation/socket/hub/build_consumer_socket_publish_handler";
import { registerAgentSocketConnectionHandlers } from "./presentation/socket/hub/register_agent_socket_handlers";
import { registerConsumerSocketConnectionHandlers } from "./presentation/socket/hub/register_consumer_socket_handlers";
import { registerSocketHubErrorHandlers } from "./presentation/socket/hub/socket_hub_error_handlers";
import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "./presentation/socket/auth/socket_namespace_auth.middleware";
import { relayMetrics } from "./presentation/socket/hub/relay/bridge_relay_health_metrics";
import { conversationRegistry } from "./presentation/socket/hub/registries/conversation_registry";
import { sweepRelayRateLimitState } from "./presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import { sweepAgentsCommandSocketRateLimitState } from "./presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";
import { sweepClientSocketEventPublishSocketRateLimitState } from "./presentation/socket/hub/rate_limits/client_socket_event_publish_socket_rate_limiter";
import { sweepAgentProfileSocketRateLimitState } from "./presentation/socket/hub/rate_limits/agent_profile_socket_rate_limiter";
import { sweepCustomSocketEventSubscriptionRateLimitState } from "./presentation/socket/hub/rate_limits/custom_socket_event_subscription_limiter";
import { sweepAgentRegisterRateLimitState } from "./presentation/socket/hub/rate_limits/agent_register_rate_limit";
import { sweepRelayOutboundQueueState } from "./presentation/socket/hub/relay/relay_outbound_queue";
import {
  registerConsumerBridgeServer,
  registerSocketBridgeServer,
} from "./presentation/socket/hub/relay/rpc_bridge";
import {
  scheduleConsumerClientAgentRoomReconcile,
  scheduleAgentProfilePush,
} from "./presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import { buildCorsOptions } from "./shared/config/cors";
import { env } from "./shared/config/env";
import { buildLegacySocketAppErrorPayload } from "./shared/constants/socket_app_error";
import { socketEvents, SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import { logger } from "./shared/utils/logger";
import {
  createSocketServerState,
  registerActiveSocketServer,
  socketServerStates,
} from "./socket_state";
import {
  countSocketsInRoom,
  disconnectAgentSocketsInRoom,
  disconnectConsumerSocketsInRoom,
  getUserId,
  runExpiredConversationCleanup,
} from "./socket_room_ops";

export {
  agentsNamespace,
  consumersNamespace,
  getAgentsNamespace,
  getConsumersNamespace,
  resolveCurrentSocketServer,
  socketServerStates,
  activeSocketServers,
  registerActiveSocketServer,
  unregisterActiveSocketServer,
  createSocketServerState,
  hasOtherOpenCustomEventDistributedCountCircuit,
  type SocketServerState,
  type HubSocket,
  type HubNamespace,
  type RoomRecipientCount,
  type RoomRemoteSocket,
  type ConsumerSocketData,
  type PendingAgentProfilePushEntry,
  type SocketSinkDisposer,
} from "./socket_state";

export {
  resolveConsumerClientAgentRoomReconcileStartDelayMs,
  selectReconcileClientEntries,
} from "./presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";

export {
  runAgentSocketDisconnectCleanup,
  runConsumerSocketDisconnectCleanup,
  runExpiredConversationCleanup,
  disconnectAgentSocketsInRoom,
  disconnectConsumerSocketsInRoom,
  countSocketsInRoom,
  countLocalSocketsInRoom,
  getUserId,
  resetStateCustomEventDistributedCountCircuit,
} from "./socket_room_ops";

export {
  closeSocketServer,
  stopSocketServerLifecycleTasksForTests,
  clearSocketServerSinkDisposers,
} from "./socket_lifecycle";

export { getSocketMetricsSnapshot } from "./socket_metrics_snapshot";

export const createSocketServer = (httpServer: HttpServer): Server => {
  const websocketOnly =
    env.socketIoTransports.length === 1 && env.socketIoTransports[0] === "websocket";

  const io = new Server(httpServer, {
    cors: buildCorsOptions(env.corsOrigins),
    maxHttpBufferSize: env.socketIoMaxHttpBufferBytes,
    perMessageDeflate: env.socketIoPerMessageDeflate,
    transports: env.socketIoTransports,
    serveClient: env.socketIoServeClient,
    httpCompression: env.socketIoHttpCompression,
    ...(websocketOnly ? { allowUpgrades: false } : {}),
    ...(env.socketIoPingIntervalMs !== undefined
      ? { pingInterval: env.socketIoPingIntervalMs }
      : {}),
    ...(env.socketIoPingTimeoutMs !== undefined ? { pingTimeout: env.socketIoPingTimeoutMs } : {}),
    ...(env.socketIoUpgradeTimeoutMs !== undefined
      ? { upgradeTimeout: env.socketIoUpgradeTimeoutMs }
      : {}),
  });

  if (env.socketEventPublishRawJsonMaxBytes > env.socketIoMaxHttpBufferBytes) {
    logger.warn("socket_custom_event_publish_envelope_exceeds_engineio_buffer", {
      socketEventPublishRawJsonMaxBytes: env.socketEventPublishRawJsonMaxBytes,
      socketIoMaxHttpBufferBytes: env.socketIoMaxHttpBufferBytes,
      message:
        "socketEventPublishRawJsonMaxBytes exceeds SOCKET_IO_MAX_HTTP_BUFFER_BYTES; large socket:event.publish payloads may be rejected by Engine.IO before the hub handler runs",
    });
  }

  const agentsNsp = io.of(SOCKET_NAMESPACES.agents);
  const consumersNsp = io.of(SOCKET_NAMESPACES.consumers);
  const state = createSocketServerState(io, agentsNsp, consumersNsp);
  socketServerStates.set(io, state);
  registerActiveSocketServer(io);

  state.sinkDisposers.push(
    registerSocketHubErrorHandlers(io.engine, [
      { name: SOCKET_NAMESPACES.agents, namespace: agentsNsp },
      { name: SOCKET_NAMESPACES.consumers, namespace: consumersNsp },
    ]),
  );

  const defaultNsp = io.of("/");
  defaultNsp.on("connection", (socket) => {
    logger.warn("Client connected to default namespace (deprecated)", {
      socketId: socket.id,
      message: "Use /agents or /consumers instead",
    });
    socket.emit(
      socketEvents.appError,
      buildLegacySocketAppErrorPayload(
        "NAMESPACE_DEPRECATED",
        "Default namespace (/) is deprecated. Connect to /agents (for agents) or /consumers (for consumers). See docs/migracao_plug_agente_namespaces.md",
      ),
    );
    socket.disconnect(true);
  });

  agentsNsp.use(authenticateAgentSocket);
  consumersNsp.use(authenticateConsumerSocket);

  registerSocketBridgeServer(agentsNsp);
  registerConsumerBridgeServer(consumersNsp);

  // Conversation idle expiry only — independent of rate-limit/outbound pruning so a burst of
  // expired conversations cannot stall map sweeps (and vice versa).
  state.conversationSweepTimer = setInterval(() => {
    const expiredConversations = conversationRegistry.removeExpired(
      env.socketRelayConversationIdleTimeoutMs,
    );
    if (expiredConversations.length > 0) {
      relayMetrics.conversationsExpiredTotal += expiredConversations.length;
    }
    runExpiredConversationCleanup(expiredConversations, consumersNsp, agentsNsp);
  }, env.socketRelayConversationSweepIntervalMs);
  state.conversationSweepTimer.unref?.();

  // Rate-limit map pruning + relay outbound queue orphan/overload refresh.
  // Cadence: SOCKET_RATE_LIMIT_SWEEP_INTERVAL_MS (falls back to SOCKET_RELAY_OUTBOUND_SWEEP_INTERVAL_MS).
  state.rateLimitSweepTimer = setInterval(() => {
    sweepRelayRateLimitState();
    sweepAgentsCommandSocketRateLimitState();
    sweepClientSocketEventPublishSocketRateLimitState();
    sweepAgentProfileSocketRateLimitState();
    sweepCustomSocketEventSubscriptionRateLimitState();
    sweepAgentRegisterRateLimitState();
    sweepRelayOutboundQueueState();
  }, env.socketRateLimitSweepIntervalMs);
  state.rateLimitSweepTimer.unref?.();
  if (env.socketConsumerClientAgentRoomReconcileIntervalMs > 0) {
    scheduleConsumerClientAgentRoomReconcile(state, consumersNsp);
  } else {
    state.consumerClientAgentRoomReconcileTimer = null;
    state.consumerClientAgentRoomReconcileStartTimeout = null;
  }

  registerAgentSocketConnectionHandlers({ agentsNsp, consumersNsp });

  registerConsumerSocketConnectionHandlers({
    state,
    consumersNsp,
    agentsNsp,
    getUserId,
  });

  if (env.socketClientAgentProfilePushEnabled) {
    state.sinkDisposers.push(
      registerAgentProfileBroadcastHandler(async (event) => {
        scheduleAgentProfilePush(state, event);
      }),
    );
  }

  state.sinkDisposers.push(
    registerAgentSocketControlHandler({
      disconnectPrincipal: async (event) => {
        await disconnectAgentSocketsInRoom(
          agentsNsp,
          `agent:principal:${event.userId}`,
          buildLegacySocketAppErrorPayload("ACCOUNT_BLOCKED", "Account is blocked"),
          {
            userId: event.userId,
            reason: event.reason,
          },
        );
      },
    }),
  );

  state.sinkDisposers.push(
    registerConsumerSocketControlHandler(
      buildConsumerSocketControlHandlers({
        consumersNsp,
        clientProfileRecipientsCacheByAgentId: state.clientProfileRecipientsCacheByAgentId,
        disconnectConsumerSocketsInRoom,
      }),
    ),
  );

  state.sinkDisposers.push(
    registerConsumerSocketEventHandler(
      buildConsumerSocketPublishHandler({
        consumersNsp,
        customEventDistributedCountCircuit: state.customEventDistributedCountCircuit,
        countSocketsInRoom: (namespace, room, options) =>
          countSocketsInRoom(state, namespace, room, options),
      }),
    ),
  );

  return io;
};
