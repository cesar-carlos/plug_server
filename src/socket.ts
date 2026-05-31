import type { Server as HttpServer } from "node:http";

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import { Server, type Namespace, type Socket } from "socket.io";

import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "./presentation/socket/auth/socket_namespace_auth.middleware";
import { agentRegistry } from "./presentation/socket/hub/registries/agent_registry";
import type { RelayConversation } from "./presentation/socket/hub/registries/conversation_registry";
import { resetConsumerCommandAbortRegistry } from "./presentation/socket/consumers/consumer_command_abort_registry";
import {
  finalizeExpiredConversations,
  buildRelayConversationEndedPayload,
  getRelayMetricsSnapshot,
  registerConsumerBridgeServer,
  resetSocketBridgeState,
  registerSocketBridgeServer,
  unregisterConsumerBridgeServer,
  unregisterSocketBridgeServer,
} from "./presentation/socket/hub/relay/rpc_bridge";
import { relayMetrics } from "./presentation/socket/hub/relay/bridge_relay_health_metrics";
import { conversationRegistry } from "./presentation/socket/hub/registries/conversation_registry";
import { consumerRegistry } from "./presentation/socket/hub/registries/consumer_registry";
import {
  getRelayRateLimitMetricsSnapshot,
  resetRelayRateLimiterState,
  sweepRelayRateLimitState,
} from "./presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import {
  getAgentsCommandSocketRateLimitMetricsSnapshot,
  resetAgentsCommandSocketRateLimitState,
  sweepAgentsCommandSocketRateLimitState,
} from "./presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";
import {
  getClientSocketEventPublishSocketRateLimitMetricsSnapshot,
  resetClientSocketEventPublishSocketRateLimitState,
  sweepClientSocketEventPublishSocketRateLimitState,
} from "./presentation/socket/hub/rate_limits/client_socket_event_publish_socket_rate_limiter";
import {
  resetAgentProfileSocketRateLimitState,
  sweepAgentProfileSocketRateLimitState,
} from "./presentation/socket/hub/rate_limits/agent_profile_socket_rate_limiter";
import { sweepRelayOutboundQueueState } from "./presentation/socket/hub/relay/relay_outbound_queue";
import { registerAgentProfileBroadcastHandler } from "./application/services/agent_profile_broadcast_sink";
import { registerAgentSocketControlHandler } from "./application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "./application/services/consumer_socket_control_sink";
import { registerConsumerSocketEventHandler } from "./application/services/consumer_socket_event_sink";
import { buildConsumerSocketControlHandlers } from "./presentation/socket/hub/build_consumer_socket_control_handlers";
import { buildConsumerSocketPublishHandler } from "./presentation/socket/hub/build_consumer_socket_publish_handler";
import {
  countDistributedRoomRecipients,
  createInitialDistributedCountCircuitState,
  resetCustomEventDistributedCountCircuit,
  type DistributedCountCircuitState,
} from "./presentation/socket/hub/custom_events/custom_socket_event_distributed_count_circuit";
import {
  clearConsumerProfilePushState,
  scheduleAgentProfilePush,
  scheduleConsumerClientAgentRoomReconcile,
  type PendingAgentProfilePush,
} from "./presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";
import {
  registerConsumerSocketConnectionHandlers,
  runConsumerSocketDisconnectCleanup as runConsumerSocketDisconnectCleanupImpl,
} from "./presentation/socket/hub/register_consumer_socket_handlers";
import {
  registerAgentSocketConnectionHandlers,
  resetAgentProfileSyncScheduler,
} from "./presentation/socket/hub/register_agent_socket_handlers";
import { registerSocketHubErrorHandlers } from "./presentation/socket/hub/socket_hub_error_handlers";
import { resetCustomSocketEventSubscriptionRateLimitState } from "./presentation/socket/hub/rate_limits/custom_socket_event_subscription_limiter";
import { resetCustomSocketEventSubscriptions } from "./presentation/socket/hub/custom_events/custom_socket_event_subscription_registry";
import { resetRestBridgeMetrics } from "./application/services/rest_bridge_metrics.service";
import { resetBridgeRpcMethodMetrics } from "./application/services/bridge_rpc_method_metrics.service";
import { resetBridgeCommandReplayGuard } from "./application/agent_commands/bridge_command_replay_guard";
import { buildCorsOptions } from "./shared/config/cors";
import { env } from "./shared/config/env";
import { socketEvents, SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import {
  buildLegacySocketAppErrorPayload,
  type LegacySocketAppErrorPayload,
} from "./shared/constants/socket_app_error";
import {
  getSocketConsumerMetricsSnapshot,
  noteAgentRoomDisconnectTriggered,
  noteConsumerRoomDisconnectTriggered,
  resetSocketConsumerMetrics,
} from "./shared/metrics/socket_consumer.metrics";
import {
  getSocketHubErrorMetricsSnapshot,
  resetSocketHubErrorMetrics,
} from "./shared/metrics/socket_hub_error.metrics";
import {
  getSocketAgentMetricsSnapshot,
  resetSocketAgentMetrics,
} from "./shared/metrics/socket_agent.metrics";
import type { JwtAccessPayload } from "./shared/utils/jwt";
import { logger } from "./shared/utils/logger";
import { TtlCache } from "./shared/utils/ttl_cache";
import { resetAgentRegisterRateLimitState } from "./presentation/socket/hub/rate_limits/agent_register_rate_limit";
import { getSocketRateLimitRedisMetricsSnapshot } from "./application/services/socket_rate_limit_redis_metrics.service";

type ConsumerSocketData = {
  user?: JwtAccessPayload;
};

type HubSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, ConsumerSocketData>;

type PendingAgentProfilePushEntry = PendingAgentProfilePush;

type RoomRemoteSocket = Awaited<ReturnType<Namespace["fetchSockets"]>>[number];

type RoomRecipientCount = {
  readonly recipients: number;
  readonly recipientCountBestEffort: boolean;
  readonly recipientCountLocalOnly: boolean;
  readonly fetchedSockets?: ReadonlyArray<RoomRemoteSocket>;
};

type SocketSinkDisposer = () => void;

type SocketServerState = {
  readonly io: Server;
  readonly agentsNamespace: ReturnType<Server["of"]>;
  readonly consumersNamespace: ReturnType<Server["of"]>;
  readonly sinkDisposers: SocketSinkDisposer[];
  readonly clientProfileRecipientsCacheByAgentId: TtlCache<string, readonly string[]>;
  readonly pendingAgentProfilePushByAgentId: Map<string, PendingAgentProfilePushEntry>;
  readonly pendingApprovedAgentIdsByClientId: Map<string, Promise<readonly string[]>>;
  readonly profilePushRecipientsInFlightByAgentId: Map<string, Promise<readonly string[]>>;
  readonly customEventDistributedCountCircuit: DistributedCountCircuitState;
  conversationSweepTimer: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileTimer: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileStartTimeout: NodeJS.Timeout | null;
  consumerClientAgentRoomReconcileInFlight: Promise<void> | null;
  consumerClientAgentRoomReconcileCursor: number;
  shuttingDown: boolean;
  profilePushFlushInFlight: Set<Promise<void>>;
};

const socketServerStates = new Map<Server, SocketServerState>();
const activeSocketServers: Server[] = [];

export {
  resolveConsumerClientAgentRoomReconcileStartDelayMs,
  selectReconcileClientEntries,
} from "./presentation/socket/hub/scheduling/consumer_client_agent_room_reconcile";

const createSocketServerState = (
  io: Server,
  agentsNsp: ReturnType<Server["of"]>,
  consumersNsp: ReturnType<Server["of"]>,
): SocketServerState => ({
  io,
  agentsNamespace: agentsNsp,
  consumersNamespace: consumersNsp,
  sinkDisposers: [],
  clientProfileRecipientsCacheByAgentId: new TtlCache<string, readonly string[]>(
    env.socketClientAgentProfileRecipientCacheTtlMs,
    env.socketClientAgentProfileRecipientCacheMaxSize,
  ),
  pendingAgentProfilePushByAgentId: new Map<string, PendingAgentProfilePush>(),
  pendingApprovedAgentIdsByClientId: new Map<string, Promise<readonly string[]>>(),
  profilePushRecipientsInFlightByAgentId: new Map<string, Promise<readonly string[]>>(),
  customEventDistributedCountCircuit: createInitialDistributedCountCircuitState(),
  conversationSweepTimer: null,
  consumerClientAgentRoomReconcileTimer: null,
  consumerClientAgentRoomReconcileStartTimeout: null,
  consumerClientAgentRoomReconcileInFlight: null,
  consumerClientAgentRoomReconcileCursor: 0,
  shuttingDown: false,
  profilePushFlushInFlight: new Set<Promise<void>>(),
});

const getUserId = (socket: HubSocket): string | null => {
  return typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;
};

const hasOtherOpenCustomEventDistributedCountCircuit = (
  currentState: SocketServerState,
  nowEpochMs = Date.now(),
): boolean => {
  for (const state of socketServerStates.values()) {
    if (state === currentState) {
      continue;
    }
    if (state.customEventDistributedCountCircuit.openedUntilEpochMs > nowEpochMs) {
      return true;
    }
  }
  return false;
};

const resetStateCustomEventDistributedCountCircuit = (
  state: SocketServerState,
  nowEpochMs = Date.now(),
): void => {
  resetCustomEventDistributedCountCircuit(
    state.customEventDistributedCountCircuit,
    () => hasOtherOpenCustomEventDistributedCountCircuit(state, nowEpochMs),
    nowEpochMs,
  );
};

/**
 * Emits a terminal `app_error` to every socket in `room` and force-disconnects
 * them. Shared by the agent and consumer variants, which differ only in the
 * metric counter and the structured-log event name.
 */
const disconnectSocketsInRoom = async (
  namespace: Namespace,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
  options: { readonly noteTriggered: () => void; readonly logEvent: string },
): Promise<number> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  options.noteTriggered();
  namespace.to(room).emit(socketEvents.appError, payload);
  namespace.in(room).disconnectSockets(true);
  if (localRecipients > 0) {
    logger.info(options.logEvent, {
      room,
      localDisconnectedCount: localRecipients,
      ...logContext,
    });
  }
  return localRecipients;
};

const disconnectAgentSocketsInRoom = async (
  namespace: Namespace,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
): Promise<number> =>
  disconnectSocketsInRoom(namespace, room, payload, logContext, {
    noteTriggered: noteAgentRoomDisconnectTriggered,
    logEvent: "agent_socket_sessions_disconnected",
  });

const countSocketsInRoom = async (
  state: SocketServerState,
  namespace: Namespace,
  room: string,
  options?: { readonly captureSockets?: boolean },
): Promise<RoomRecipientCount> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  if (options?.captureSockets === true) {
    return countDistributedRoomRecipients<RoomRemoteSocket>({
      circuit: state.customEventDistributedCountCircuit,
      localRecipients,
      room,
      fetchDistributedSockets: async () => namespace.in(room).fetchSockets(),
      onCircuitReset: () => resetStateCustomEventDistributedCountCircuit(state),
    });
  }
  return countDistributedRoomRecipients({
    circuit: state.customEventDistributedCountCircuit,
    localRecipients,
    room,
    fetchDistributedCount: async () => (await namespace.in(room).fetchSockets()).length,
    onCircuitReset: () => resetStateCustomEventDistributedCountCircuit(state),
  });
};

const countLocalSocketsInRoom = (namespace: Namespace, room: string): number =>
  namespace.adapter.rooms.get(room)?.size ?? 0;

const disconnectConsumerSocketsInRoom = async (
  namespace: Namespace,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
): Promise<number> =>
  disconnectSocketsInRoom(namespace, room, payload, logContext, {
    noteTriggered: noteConsumerRoomDisconnectTriggered,
    logEvent: "consumer_socket_sessions_disconnected",
  });

type HubNamespace = ReturnType<Server["of"]>;

export { runAgentSocketDisconnectCleanup } from "./presentation/socket/hub/register_agent_socket_handlers";

export const runConsumerSocketDisconnectCleanup = (
  socket: HubSocket,
  agentsNsp: HubNamespace,
): void => {
  runConsumerSocketDisconnectCleanupImpl(socket, agentsNsp, getUserId);
};

export const runExpiredConversationCleanup = (
  expiredConversations: readonly RelayConversation[],
  consumersNsp: HubNamespace,
  agentsNsp: HubNamespace,
): void => {
  finalizeExpiredConversations(
    expiredConversations,
    (conversation) => {
      const consumerSocket = consumersNsp.sockets.get(conversation.consumerSocketId);
      consumerSocket?.emit(
        socketEvents.relayConversationEnded,
        buildRelayConversationEndedPayload(conversation.conversationId, "expired"),
      );
    },
    (conversation) => {
      const agentSocket = agentsNsp.sockets.get(conversation.agentSocketId);
      agentSocket?.emit(
        socketEvents.relayConversationEnded,
        buildRelayConversationEndedPayload(conversation.conversationId, "expired"),
      );
    },
  );
};

export let agentsNamespace: ReturnType<Server["of"]> | null = null;
export let consumersNamespace: ReturnType<Server["of"]> | null = null;
const resolveCurrentSocketServer = (): Server | null =>
  activeSocketServers.length > 0 ? activeSocketServers[activeSocketServers.length - 1]! : null;

const registerActiveSocketServer = (io: Server): void => {
  activeSocketServers.push(io);
  const state = socketServerStates.get(io);
  agentsNamespace = state?.agentsNamespace ?? null;
  consumersNamespace = state?.consumersNamespace ?? null;
};

const unregisterActiveSocketServer = (io: Server): void => {
  const index = activeSocketServers.lastIndexOf(io);
  if (index >= 0) {
    activeSocketServers.splice(index, 1);
  }
  const current = resolveCurrentSocketServer();
  const state = current ? socketServerStates.get(current) : undefined;
  agentsNamespace = state?.agentsNamespace ?? null;
  consumersNamespace = state?.consumersNamespace ?? null;
};

const emitServerShutdownNotice = (io: Server, signal: string): void => {
  const payload = buildLegacySocketAppErrorPayload(
    "SERVER_SHUTDOWN",
    `Server is shutting down (${signal}). Reconnect after a few seconds.`,
  );

  io.of(SOCKET_NAMESPACES.agents).emit(socketEvents.appError, payload);
  io.of(SOCKET_NAMESPACES.consumers).emit(socketEvents.appError, payload);
};

export const getSocketMetricsSnapshot = (): {
  readonly namespaces: {
    readonly agents: number;
    readonly consumers: number;
  };
  readonly relay: ReturnType<typeof getRelayMetricsSnapshot>;
  readonly relayRateLimit: ReturnType<typeof getRelayRateLimitMetricsSnapshot>;
  readonly socketRateLimitRedis: ReturnType<typeof getSocketRateLimitRedisMetricsSnapshot>;
  readonly agentsCommandSocketRateLimit: ReturnType<
    typeof getAgentsCommandSocketRateLimitMetricsSnapshot
  >;
  readonly clientSocketEventPublishSocketRateLimit: ReturnType<
    typeof getClientSocketEventPublishSocketRateLimitMetricsSnapshot
  >;
  readonly consumerRuntime: ReturnType<typeof getSocketConsumerMetricsSnapshot>;
  readonly agentRuntime: ReturnType<typeof getSocketAgentMetricsSnapshot>;
  readonly hubErrors: ReturnType<typeof getSocketHubErrorMetricsSnapshot>;
} => {
  const io = resolveCurrentSocketServer();
  return {
    namespaces: {
      agents: io?.of(SOCKET_NAMESPACES.agents).sockets.size ?? 0,
      consumers: io?.of(SOCKET_NAMESPACES.consumers).sockets.size ?? 0,
    },
    relay: getRelayMetricsSnapshot(),
    relayRateLimit: getRelayRateLimitMetricsSnapshot(),
    socketRateLimitRedis: getSocketRateLimitRedisMetricsSnapshot(),
    agentsCommandSocketRateLimit: getAgentsCommandSocketRateLimitMetricsSnapshot(),
    clientSocketEventPublishSocketRateLimit:
      getClientSocketEventPublishSocketRateLimitMetricsSnapshot(),
    consumerRuntime: getSocketConsumerMetricsSnapshot(),
    agentRuntime: getSocketAgentMetricsSnapshot(),
    hubErrors: getSocketHubErrorMetricsSnapshot(),
  };
};

const clearSocketServerSinkDisposers = (io: Server): void => {
  const state = socketServerStates.get(io);
  if (!state) {
    return;
  }
  for (const dispose of state.sinkDisposers) {
    dispose();
  }
  state.sinkDisposers.length = 0;
};

const awaitInFlightPromises = async (
  promises: readonly Promise<unknown>[],
  logEvent: string,
): Promise<void> => {
  if (promises.length === 0) {
    return;
  }
  await Promise.all(
    promises.map((promise) =>
      promise.catch((error: unknown) => {
        logger.warn(logEvent, {
          message: error instanceof Error ? error.message : String(error),
        });
      }),
    ),
  );
};

const stopSocketServerLifecycleTasks = async (state: SocketServerState): Promise<void> => {
  state.shuttingDown = true;

  if (state.conversationSweepTimer) {
    clearInterval(state.conversationSweepTimer);
    state.conversationSweepTimer = null;
  }
  if (state.consumerClientAgentRoomReconcileTimer) {
    clearInterval(state.consumerClientAgentRoomReconcileTimer);
    state.consumerClientAgentRoomReconcileTimer = null;
  }
  if (state.consumerClientAgentRoomReconcileStartTimeout) {
    clearTimeout(state.consumerClientAgentRoomReconcileStartTimeout);
    state.consumerClientAgentRoomReconcileStartTimeout = null;
  }

  const reconcileInFlight = state.consumerClientAgentRoomReconcileInFlight;
  if (reconcileInFlight !== null) {
    await reconcileInFlight.catch((error: unknown) => {
      logger.warn("consumer_socket_client_agent_room_reconcile_shutdown_drain_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  state.consumerClientAgentRoomReconcileInFlight = null;
  state.consumerClientAgentRoomReconcileCursor = 0;

  await awaitInFlightPromises(
    [...state.profilePushFlushInFlight],
    "client_agent_profile_push_shutdown_drain_failed",
  );
  state.profilePushFlushInFlight.clear();
  await awaitInFlightPromises(
    [...state.profilePushRecipientsInFlightByAgentId.values()],
    "client_agent_profile_push_recipient_shutdown_drain_failed",
  );
  await awaitInFlightPromises(
    [...state.pendingApprovedAgentIdsByClientId.values()],
    "consumer_socket_client_agent_room_bootstrap_shutdown_drain_failed",
  );

  clearConsumerProfilePushState(state, () => hasOtherOpenCustomEventDistributedCountCircuit(state));
};

export const stopSocketServerLifecycleTasksForTests = stopSocketServerLifecycleTasks;

export const closeSocketServer = async (io: Server, signal = "shutdown"): Promise<void> => {
  emitServerShutdownNotice(io, signal);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const state = socketServerStates.get(io);
  if (state) {
    await stopSocketServerLifecycleTasks(state);
  }

  clearSocketServerSinkDisposers(io);
  unregisterSocketBridgeServer(io.of(SOCKET_NAMESPACES.agents));
  unregisterConsumerBridgeServer(io.of(SOCKET_NAMESPACES.consumers));
  unregisterActiveSocketServer(io);
  socketServerStates.delete(io);

  if (activeSocketServers.length === 0) {
    resetRelayRateLimiterState();
    resetAgentsCommandSocketRateLimitState();
    resetClientSocketEventPublishSocketRateLimitState();
    resetAgentProfileSocketRateLimitState();
    resetConsumerCommandAbortRegistry();
    resetCustomSocketEventSubscriptions();
    resetCustomSocketEventSubscriptionRateLimitState();
    resetSocketConsumerMetrics();
    resetSocketAgentMetrics();
    resetAgentRegisterRateLimitState();
    resetAgentProfileSyncScheduler();
    resetSocketBridgeState();
    resetRestBridgeMetrics();
    resetBridgeRpcMethodMetrics();
    resetBridgeCommandReplayGuard();
    resetSocketHubErrorMetrics();
    conversationRegistry.clear();
    agentRegistry.clear();
    consumerRegistry.clear();
  }

  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
};

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

  registerSocketHubErrorHandlers(io.engine, [
    { name: SOCKET_NAMESPACES.agents, namespace: agentsNsp },
    { name: SOCKET_NAMESPACES.consumers, namespace: consumersNsp },
  ]);

  const defaultNsp = io.of("/");
  defaultNsp.on("connection", (socket: Socket) => {
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

  state.conversationSweepTimer = setInterval(() => {
    sweepRelayRateLimitState();
    sweepAgentsCommandSocketRateLimitState();
    sweepClientSocketEventPublishSocketRateLimitState();
    sweepAgentProfileSocketRateLimitState();
    sweepRelayOutboundQueueState();
    const expiredConversations = conversationRegistry.removeExpired(
      env.socketRelayConversationIdleTimeoutMs,
    );
    if (expiredConversations.length > 0) {
      relayMetrics.conversationsExpiredTotal += expiredConversations.length;
    }
    runExpiredConversationCleanup(expiredConversations, consumersNsp, agentsNsp);
  }, env.socketRelayConversationSweepIntervalMs);
  state.conversationSweepTimer.unref?.();
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
