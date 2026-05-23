import type { Server as HttpServer } from "node:http";

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import { Server, type Namespace, type Socket } from "socket.io";

import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "./presentation/socket/auth/socket_namespace_auth.middleware";
import { agentRegistry } from "./presentation/socket/hub/agent_registry";
import type { RelayConversation } from "./presentation/socket/hub/conversation_registry";
import { resetConsumerCommandAbortRegistry } from "./presentation/socket/consumers/consumer_command_abort_registry";
import {
  cleanupAgentStreamSubscriptions,
  cleanupAgentInboundSocketState,
  cleanupConversationStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
  finalizeExpiredConversations,
  buildRelayConversationEndedPayload,
  dispatchRpcCommandToAgent,
  getRelayMetricsSnapshot,
  handleAgentBatchAck,
  handleAgentRpcAck,
  handleAgentRpcChunk,
  handleAgentRpcComplete,
  handleAgentRpcResponse,
  registerAgentBridgeSocket,
  registerConsumerBridgeServer,
  resetSocketBridgeState,
  registerSocketBridgeServer,
  unregisterAgentBridgeSocket,
  unregisterConsumerBridgeServer,
  unregisterSocketBridgeServer,
} from "./presentation/socket/hub/rpc_bridge";
import { relayMetrics } from "./presentation/socket/hub/bridge_relay_health_metrics";
import { emitConnectionReady } from "./presentation/socket/hub/connection_ready_handshake";
import { conversationRegistry } from "./presentation/socket/hub/conversation_registry";
import { consumerRegistry } from "./presentation/socket/hub/consumer_registry";
import {
  getRelayRateLimitMetricsSnapshot,
  resetRelayRateLimiterState,
  sweepRelayRateLimitState,
} from "./presentation/socket/hub/consumer_relay_rate_limiter";
import {
  getAgentsCommandSocketRateLimitMetricsSnapshot,
  resetAgentsCommandSocketRateLimitState,
  sweepAgentsCommandSocketRateLimitState,
} from "./presentation/socket/hub/agents_command_socket_rate_limiter";
import {
  getClientSocketEventPublishSocketRateLimitMetricsSnapshot,
  resetClientSocketEventPublishSocketRateLimitState,
  sweepClientSocketEventPublishSocketRateLimitState,
} from "./presentation/socket/hub/client_socket_event_publish_socket_rate_limiter";
import {
  allowAgentProfileSocketUpdate,
  clearAgentProfileSocketRateLimitStateForAgentId,
  clearAgentProfileSocketRateLimitStateForSocketId,
  resetAgentProfileSocketRateLimitState,
  sweepAgentProfileSocketRateLimitState,
} from "./presentation/socket/hub/agent_profile_socket_rate_limiter";
import {
  acquireAgentProfileSyncSlot,
  resetAgentProfileSyncConcurrency,
} from "./presentation/socket/hub/agent_profile_sync_concurrency";
import { AgentProfileSyncScheduler } from "./presentation/socket/hub/agent_profile_sync_scheduler";
import { sweepRelayOutboundQueueState } from "./presentation/socket/hub/relay_outbound_queue";
import { registerAgentProfileBroadcastHandler } from "./application/services/agent_profile_broadcast_sink";
import type { AgentRegisterProfileSnapshot } from "./application/services/agent_profile_sync.service";
import { agentProfileReliabilityMetrics } from "./application/services/agent_profile_reliability_metrics.service";
import { registerAgentSocketControlHandler } from "./application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "./application/services/consumer_socket_control_sink";
import { registerConsumerSocketEventHandler } from "./application/services/consumer_socket_event_sink";
import {
  clearAllConsumerSocketAgentAccessSnapshots,
  clearConsumerSocketAgentAccessSnapshot,
} from "./presentation/socket/consumers/consumer_socket_guard";
import {
  buildConsumerClientAgentRoom,
  buildConsumerClientRoom as buildClientRoomName,
  joinConsumerClientAgentRoom,
} from "./presentation/socket/hub/consumer_identity_rooms";
import {
  shouldSkipCustomSocketEventZeroRecipientEarlyReturn,
} from "./presentation/socket/hub/custom_socket_event_room_recipient_count";
import {
  countDistributedRoomRecipients,
  createInitialDistributedCountCircuitState,
  enforceCustomEventDistributedCountCircuit,
  resetCustomEventDistributedCountCircuit,
  type DistributedCountCircuitState,
} from "./presentation/socket/hub/custom_socket_event_distributed_count_circuit";
import {
  clearConsumerProfilePushState,
  scheduleAgentProfilePush,
  scheduleConsumerClientAgentRoomReconcile,
  type PendingAgentProfilePush,
} from "./presentation/socket/hub/consumer_client_agent_room_reconcile";
import {
  registerConsumerSocketConnectionHandlers,
  runConsumerSocketDisconnectCleanup as runConsumerSocketDisconnectCleanupImpl,
} from "./presentation/socket/hub/register_consumer_socket_handlers";
import { registerSocketHubErrorHandlers } from "./presentation/socket/hub/socket_hub_error_handlers";
import { buildCustomSocketEventRoom } from "./presentation/socket/hub/custom_socket_event_rooms";
import { resetCustomSocketEventSubscriptionRateLimitState } from "./presentation/socket/hub/custom_socket_event_subscription_limiter";
import { resetCustomSocketEventSubscriptions } from "./presentation/socket/hub/custom_socket_event_subscription_registry";
import { resetRestBridgeMetrics } from "./application/services/rest_bridge_metrics.service";
import { resetBridgeRpcMethodMetrics } from "./application/services/bridge_rpc_method_metrics.service";
import { buildCorsOptions } from "./shared/config/cors";
import { env } from "./shared/config/env";
import { AppError } from "./shared/errors/app_error";
import { badRequest, forbidden, tooManyRequests } from "./shared/errors/http_errors";
import { buildHubServerCapabilities } from "./shared/constants/agent_transport_contract";
import { socketEvents, SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import {
  buildLegacySocketAppErrorPayload,
  type LegacySocketAppErrorPayload,
} from "./shared/constants/socket_app_error";
import { container } from "./shared/di/container";
import {
  getSocketConsumerMetricsSnapshot,
  noteConsumerClientAgentRoomGrantAttempt,
  noteConsumerClientAgentRoomGrantFetchFailed,
  noteConsumerClientAgentRoomGrantJoinFailed,
  noteConsumerClientAgentRoomGrantSocketsJoined,
  noteCustomSocketEventPublishRecipientCapUnverified,
  noteCustomSocketEventPublishRecipientCountBestEffort,
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
  noteAgentReadyInvalidPartialPayload,
  noteAgentReadyLegacyPayload,
  noteAgentCapabilityProfile,
  noteAgentRegisterRateLimited,
  noteAgentSessionRejectedActive,
  noteAgentSessionTakeoverDisconnect,
  resetSocketAgentMetrics,
} from "./shared/metrics/socket_agent.metrics";
import type { JwtAccessPayload } from "./shared/utils/jwt";
import { logger } from "./shared/utils/logger";
import { TtlCache } from "./shared/utils/ttl_cache";
import {
  decodePayloadFrameAsync,
  encodePayloadFrame,
  encodePayloadFrameBridge,
  encodePayloadFrameHotPath,
  payloadFrameEncodeOptionsFromPreference,
} from "./shared/utils/payload_frame";
import { agentSelfProfileSocketSchema } from "./presentation/http/validators/agent_self_profile.validator";
import { agentRegisterPayloadSchema, type AgentRegisterPayload } from "./shared/validators/agent_register";
import {
  AGENT_REGISTER_SESSION_ACTIVE_MESSAGE,
  AGENT_REGISTER_RATE_LIMIT_MESSAGE,
  AGENT_SESSION_SUPERSEDED_MESSAGE,
  emitAgentRegisterError,
} from "./presentation/socket/hub/agent_register_error";
import {
  tryConsumeAgentRegisterRateLimitAsync,
  resetAgentRegisterRateLimitState,
} from "./presentation/socket/hub/agent_register_rate_limit";
import { toAgentCatalogDto } from "./presentation/http/serializers/agent_catalog.serializer";
import { getSocketRateLimitRedisMetricsSnapshot } from "./application/services/socket_rate_limit_redis_metrics.service";
import { parseAgentReadyPayload } from "./presentation/socket/hub/agent_ready_payload";

type AgentCapabilities = AgentRegisterPayload["capabilities"];

type SocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: AgentCapabilities;
  agentRegisterProfileSnapshot?: AgentRegisterProfileSnapshot;
};

type HubSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

type PendingAgentProfilePushEntry = PendingAgentProfilePush;

type RoomRecipientCount = {
  readonly recipients: number;
  readonly recipientCountBestEffort: boolean;
  readonly recipientCountLocalOnly: boolean;
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
} from "./presentation/socket/hub/consumer_client_agent_room_reconcile";

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

const emitAppError = (socket: HubSocket, message: string): void => {
  socket.emit(
    socketEvents.appError,
    buildLegacySocketAppErrorPayload("SOCKET_PROTOCOL_ERROR", message),
  );
};

const getUserId = (socket: HubSocket): string | null => {
  return typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;
};

const buildAgentPrincipalRoom = (user: JwtAccessPayload | undefined): string | null => {
  return typeof user?.sub === "string" && user.sub.trim() !== ""
    ? `agent:principal:${user.sub}`
    : null;
};

const joinAgentIdentityRooms = async (socket: HubSocket): Promise<void> => {
  const room = buildAgentPrincipalRoom(socket.data.user);
  if (room) {
    await socket.join(room);
  }
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

const disconnectAgentSocketsInRoom = async (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
): Promise<number> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  noteAgentRoomDisconnectTriggered();
  namespace.to(room).emit(socketEvents.appError, payload);
  namespace.in(room).disconnectSockets(true);
  if (localRecipients > 0) {
    logger.info("agent_socket_sessions_disconnected", {
      room,
      localDisconnectedCount: localRecipients,
      ...logContext,
    });
  }
  return localRecipients;
};

const countSocketsInRoom = async (
  state: SocketServerState,
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
): Promise<RoomRecipientCount> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  return countDistributedRoomRecipients({
    circuit: state.customEventDistributedCountCircuit,
    localRecipients,
    room,
    fetchDistributedCount: async () => (await namespace.in(room).fetchSockets()).length,
    onCircuitReset: () => resetStateCustomEventDistributedCountCircuit(state),
  });
};

const countLocalSocketsInRoom = (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
): number => namespace.adapter.rooms.get(room)?.size ?? 0;

const disconnectConsumerSocketsInRoom = async (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
  payload: LegacySocketAppErrorPayload,
  logContext: Record<string, unknown>,
): Promise<number> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  noteConsumerRoomDisconnectTriggered();
  namespace.to(room).emit(socketEvents.appError, payload);
  namespace.in(room).disconnectSockets(true);
  if (localRecipients > 0) {
    logger.info("consumer_socket_sessions_disconnected", {
      room,
      localDisconnectedCount: localRecipients,
      ...logContext,
    });
  }
  return localRecipients;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const resolveRequiresExplicitProtocolReadyAck = (capabilities: AgentCapabilities): boolean => {
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
  return (
    extensions?.protocolReadyAck === true ||
    extensions?.protocol_ready_ack === true ||
    capabilities.protocolReadyAck === true ||
    capabilities.protocol_ready_ack === true
  );
};

const withOptionalRequestId = (
  requestId: string | null | undefined,
): { readonly requestId?: string } => {
  return requestId ? { requestId } : {};
};

const emitAgentProfileUpdated = (
  socket: HubSocket,
  requestId: string | null | undefined,
  payload: Record<string, unknown>,
): void => {
  socket.emit(
    socketEvents.agentProfileUpdated,
    encodePayloadFrame(payload, { ...withOptionalRequestId(requestId), omitTraceId: true }),
  );
};

const emitAgentProfileUpdateError = (
  socket: HubSocket,
  input: {
    readonly requestId: string | null | undefined;
    readonly agentId?: string;
    readonly error: AppError;
  },
): void => {
  emitAgentProfileUpdated(socket, input.requestId, {
    success: false,
    ...(input.agentId !== undefined ? { agent_id: input.agentId } : {}),
    error: {
      code: input.error.code,
      message: input.error.message,
      statusCode: input.error.statusCode,
    },
  });
};

const resolveCanonicalRegisteredAgentId = (
  socket: HubSocket,
  eventName: string,
  payloadAgentId: unknown,
): string | null => {
  const registeredAgentId = socket.data.agentId;
  if (!registeredAgentId) {
    emitAppError(socket, `${eventName} received before agent registration`);
    return null;
  }
  if (typeof payloadAgentId === "string" && payloadAgentId !== registeredAgentId) {
    emitAppError(socket, `${eventName} agent_id does not match registered socket agent`);
    return null;
  }
  const registeredAgent = agentRegistry.findByAgentId(registeredAgentId);
  if (!registeredAgent || registeredAgent.socketId !== socket.id) {
    emitAppError(socket, `${eventName} received from non-canonical agent socket`);
    return null;
  }
  return registeredAgentId;
};

const resolveAgentRegisterProfileSnapshot = (payload: {
  readonly profile: Record<string, unknown> | undefined;
  readonly profile_version: number | undefined;
  readonly profile_updated_at: string | undefined;
}): AgentRegisterProfileSnapshot | undefined => {
  if (
    payload.profile === undefined ||
    payload.profile_version === undefined ||
    payload.profile_updated_at === undefined
  ) {
    return undefined;
  }
  const profileUpdatedAt = new Date(payload.profile_updated_at);
  if (Number.isNaN(profileUpdatedAt.getTime())) {
    return undefined;
  }
  return {
    profile: payload.profile,
    profileVersion: payload.profile_version,
    profileUpdatedAt,
  };
};

const agentProfileSyncScheduler = new AgentProfileSyncScheduler({
  syncFromRegisterSnapshot: (input) =>
    container.agentProfileSyncService.syncFromRegisterSnapshot(input),
  syncFromConnectedAgent: (input) =>
    container.agentProfileSyncService.syncFromConnectedAgent({
      agentId: input.agentId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      dispatch: dispatchRpcCommandToAgent,
      timeoutMs: input.timeoutMs,
    }),
  acquireSlot: acquireAgentProfileSyncSlot,
  metrics: agentProfileReliabilityMetrics,
  logger,
});

const clearAgentProfileSyncState = (agentId: string): void => {
  agentProfileSyncScheduler.clear(agentId);
};

const scheduleAgentProfileSync = (
  input: {
    readonly agentId: string;
    readonly userId: string | null;
    readonly snapshot?: AgentRegisterProfileSnapshot;
  },
  delayMs = 1_200,
): void => {
  agentProfileSyncScheduler.schedule(input, delayMs);
};

type ConsumersNamespace = ReturnType<Server["of"]>;

export const runAgentSocketDisconnectCleanup = (
  socket: HubSocket,
  consumersNsp: ConsumersNamespace,
): void => {
  unregisterAgentBridgeSocket(socket.id);
  const cleanedPendingRequests = cleanupPendingRequestsForAgentSocket(socket.id);
  cleanupAgentInboundSocketState(socket.id);
  cleanupAgentStreamSubscriptions(socket.id);
  clearAgentProfileSocketRateLimitStateForSocketId(socket.id);
  const endedConversations = conversationRegistry.removeByAgentSocketId(socket.id);
  for (const conversation of endedConversations) {
    cleanupConversationStreamSubscriptions(conversation.conversationId);
    const consumerSocket = consumersNsp.sockets.get(conversation.consumerSocketId);
    consumerSocket?.emit(socketEvents.relayConversationEnded, {
      success: true,
      conversationId: conversation.conversationId,
      reason: "agent_disconnected",
    });
  }

  const removedAgent = agentRegistry.removeBySocketId(socket.id);
  if (removedAgent) {
    clearAgentProfileSyncState(removedAgent.agentId);
    clearAgentProfileSocketRateLimitStateForAgentId(removedAgent.agentId);
    logger.info("Agent disconnected from hub", {
      socketId: socket.id,
      agentId: removedAgent.agentId,
      userId: removedAgent.userId,
      cleanedPendingRequests,
    });
  }
};

export const runConsumerSocketDisconnectCleanup = (
  socket: HubSocket,
  agentsNsp: ConsumersNamespace,
): void => {
  runConsumerSocketDisconnectCleanupImpl(socket, agentsNsp, getUserId);
};

export const runExpiredConversationCleanup = (
  expiredConversations: readonly RelayConversation[],
  consumersNsp: ConsumersNamespace,
  agentsNsp: ConsumersNamespace,
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

  clearConsumerProfilePushState(state, () =>
    hasOtherOpenCustomEventDistributedCountCircuit(state),
  );
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
    resetAgentProfileSyncConcurrency();
    resetSocketBridgeState();
    resetRestBridgeMetrics();
    resetBridgeRpcMethodMetrics();
    resetSocketHubErrorMetrics();
    conversationRegistry.clear();
    agentRegistry.clear();
    consumerRegistry.clear();
    agentProfileSyncScheduler.reset();
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

  agentsNsp.on("connection", async (socket: HubSocket) => {
    registerAgentBridgeSocket(agentsNsp, socket.id);
    logger.info("Socket client connected", {
      socketId: socket.id,
      userId: getUserId(socket),
    });

    try {
      await joinAgentIdentityRooms(socket);
    } catch (error: unknown) {
      logger.warn("agent_socket_identity_room_join_failed", {
        socketId: socket.id,
        userId: getUserId(socket),
        message: error instanceof Error ? error.message : String(error),
      });
      unregisterAgentBridgeSocket(socket.id);
      socket.emit(
        socketEvents.appError,
        buildLegacySocketAppErrorPayload("ROOM_JOIN_FAILED", "Failed to join agent identity room"),
      );
      socket.disconnect(true);
      return;
    }

    emitConnectionReady(socket, {
      id: socket.id,
      message: "Socket connected successfully",
      user: socket.data.user ?? null,
    });

    socket.on(socketEvents.agentRegister, async (rawPayload: unknown) => {
      const decoded = await decodePayloadFrameAsync(rawPayload);
      if (!decoded.ok) {
        emitAgentRegisterError(socket, "invalid_payload", decoded.error.message);
        return;
      }

      const parsed = agentRegisterPayloadSchema.safeParse(decoded.value.data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.join(".");
        const detail = issue ? `${path ? `${path}: ` : ""}${issue.message}` : "validation failed";
        emitAgentRegisterError(
          socket,
          "invalid_request",
          `agent:register payload is invalid (${detail})`,
        );
        return;
      }

      const { agentId, capabilities } = parsed.data;

      if (socket.data.agentId && socket.data.agentId !== agentId) {
        emitAgentRegisterError(
          socket,
          "invalid_request",
          "agent:register cannot change agentId for an already registered socket",
          {
            currentAgentId: socket.data.agentId,
            requestedAgentId: agentId,
          },
        );
        return;
      }

      const tokenAgentId = socket.data.user?.agent_id;
      if (
        typeof tokenAgentId === "string" &&
        tokenAgentId.trim() !== "" &&
        tokenAgentId !== agentId
      ) {
        emitAgentRegisterError(
          socket,
          "authentication_failed",
          "agent:register agentId does not match token claim",
          { agentId, tokenAgentId },
        );
        return;
      }

      const userId = getUserId(socket);
      if (!userId) {
        emitAgentRegisterError(
          socket,
          "authentication_failed",
          "agent:register requires authenticated user context",
          { agentId },
        );
        return;
      }

      const rateLimitOk = await tryConsumeAgentRegisterRateLimitAsync(userId, agentId);
      if (!rateLimitOk.ok) {
        noteAgentRegisterRateLimited();
        emitAgentRegisterError(socket, "rate_limited", AGENT_REGISTER_RATE_LIMIT_MESSAGE, {
          agentId,
          userId,
          policy: env.socketAgentSessionPolicy,
        });
        return;
      }

      let bindResult: Awaited<
        ReturnType<typeof container.agentAccessService.bindOwnershipOnRegister>
      >;
      try {
        bindResult = await container.agentAccessService.bindOwnershipOnRegister(userId, agentId);
      } catch (error: unknown) {
        logger.warn("agent_register_ownership_bind_failed", {
          socketId: socket.id,
          agentId,
          userId,
          message: error instanceof Error ? error.message : String(error),
        });
        emitAgentRegisterError(
          socket,
          "transient_failure",
          "agent:register failed while validating agent ownership",
          { agentId, userId },
        );
        return;
      }
      if (!bindResult.ok) {
        emitAgentRegisterError(socket, "unauthorized", bindResult.error.message, {
          agentId,
          userId,
        });
        return;
      }

      const registration = agentRegistry.registerAgentSession({
        agentId,
        socketId: socket.id,
        userId,
        capabilities,
        policy: env.socketAgentSessionPolicy,
        isPeerConnected: (sid) => agentsNsp.sockets.has(sid),
      });

      if (!registration.ok) {
        if (registration.reason === "SESSION_ACTIVE") {
          noteAgentSessionRejectedActive();
          emitAgentRegisterError(
            socket,
            "session_active",
            AGENT_REGISTER_SESSION_ACTIVE_MESSAGE,
            {
              agentId,
              userId,
              policy: env.socketAgentSessionPolicy,
            },
            { code: "same_agent_session_active" },
          );
          return;
        }
        emitAgentRegisterError(
          socket,
          "unauthorized",
          "agent:register denied because this agentId belongs to another user",
          { agentId, userId },
        );
        return;
      }

      if (registration.replacedSocketId !== undefined) {
        noteAgentSessionTakeoverDisconnect();
        const previousSocket = agentsNsp.sockets.get(registration.replacedSocketId);
        if (previousSocket) {
          previousSocket.emit(socketEvents.agentSessionSuperseded, {
            reason: "session_superseded",
            message: AGENT_SESSION_SUPERSEDED_MESSAGE,
            policy: env.socketAgentSessionPolicy,
          });
          previousSocket.disconnect(true);
        }
        logger.info("agent_session_takeover_disconnect", {
          agentId,
          userId,
          policy: env.socketAgentSessionPolicy,
          previousSocketId: registration.replacedSocketId,
          newSocketId: socket.id,
        });
      }

      socket.data.agentId = agentId;
      socket.data.capabilities = capabilities;
      const registerProfileSnapshot = resolveAgentRegisterProfileSnapshot({
        profile: parsed.data.profile,
        profile_version: parsed.data.profile_version,
        profile_updated_at: parsed.data.profile_updated_at,
      });
      if (registerProfileSnapshot !== undefined) {
        socket.data.agentRegisterProfileSnapshot = registerProfileSnapshot;
      } else {
        delete socket.data.agentRegisterProfileSnapshot;
      }
      noteAgentCapabilityProfile(capabilities);
      const requiresExplicitReadyAck = resolveRequiresExplicitProtocolReadyAck(capabilities);

      logger.info("Agent registered on hub", {
        socketId: socket.id,
        agentId,
        userId,
      });

      socket.emit(
        socketEvents.agentCapabilities,
        encodePayloadFrameHotPath(
          {
            capabilities: buildHubServerCapabilities({
              recommendedStreamPullWindowSize: env.socketRestStreamPullWindowSize,
              maxStreamPullWindowSize: env.socketRestStreamPullMaxWindowSize,
            }),
          },
          withOptionalRequestId(decoded.value.frame.requestId),
        ),
      );

      if (!requiresExplicitReadyAck) {
        scheduleAgentProfileSync({
          agentId,
          userId,
          ...(socket.data.agentRegisterProfileSnapshot !== undefined
            ? { snapshot: socket.data.agentRegisterProfileSnapshot }
            : {}),
        });
      }
    });

    socket.on(socketEvents.agentHeartbeat, async (rawPayload: unknown) => {
      const decoded = await decodePayloadFrameAsync(rawPayload);
      if (!decoded.ok) {
        emitAppError(socket, decoded.error.message);
        return;
      }

      const payloadAgentId = isRecord(decoded.value.data) ? decoded.value.data.agent_id : undefined;
      const currentAgentId = resolveCanonicalRegisteredAgentId(
        socket,
        socketEvents.agentHeartbeat,
        payloadAgentId,
      );
      if (!currentAgentId) {
        return;
      }

      agentRegistry.touch(currentAgentId, { markProtocolReady: true, socketId: socket.id });

      socket.emit(
        socketEvents.hubHeartbeatAck,
        encodePayloadFrameHotPath(
          {
            agent_id: currentAgentId,
            timestamp: new Date().toISOString(),
            status: "ok",
          },
          withOptionalRequestId(decoded.value.frame.requestId),
        ),
      );
    });

    socket.on(socketEvents.agentReady, async (rawPayload: unknown) => {
      const decoded = await decodePayloadFrameAsync(rawPayload);
      if (!decoded.ok) {
        emitAppError(socket, decoded.error.message);
        return;
      }

      const parsedReadyPayload = parseAgentReadyPayload(decoded.value.data);
      if (!parsedReadyPayload.ok) {
        if (parsedReadyPayload.reason === "invalid_partial_payload") {
          noteAgentReadyInvalidPartialPayload();
          logger.warn("agent_ready_invalid_partial_payload", {
            socketId: socket.id,
          });
        }
        emitAppError(socket, "agent:ready payload is invalid");
        return;
      }
      if (parsedReadyPayload.legacy) {
        noteAgentReadyLegacyPayload();
        logger.warn("agent_ready_legacy_payload", {
          socketId: socket.id,
          agentId: parsedReadyPayload.agentId,
          missingTimestamp: true,
          missingProtocol: true,
        });
      }

      const currentAgentId = resolveCanonicalRegisteredAgentId(
        socket,
        socketEvents.agentReady,
        parsedReadyPayload.agentId,
      );
      if (!currentAgentId) {
        return;
      }

      agentRegistry.touch(currentAgentId, { markProtocolReady: true, socketId: socket.id });

      const capabilities = isRecord(socket.data.capabilities) ? socket.data.capabilities : null;
      if (capabilities && resolveRequiresExplicitProtocolReadyAck(capabilities)) {
        scheduleAgentProfileSync({
          agentId: currentAgentId,
          userId: getUserId(socket),
          ...(socket.data.agentRegisterProfileSnapshot !== undefined
            ? { snapshot: socket.data.agentRegisterProfileSnapshot }
            : {}),
        });
      }
    });

    socket.on(socketEvents.agentProfileUpdate, async (rawPayload: unknown) => {
      const decoded = await decodePayloadFrameAsync(rawPayload);
      if (!decoded.ok) {
        emitAgentProfileUpdateError(socket, {
          requestId: undefined,
          error: badRequest(decoded.error.message),
        });
        return;
      }

      const requestId = decoded.value.frame.requestId;

      if (!isRecord(decoded.value.data)) {
        emitAgentProfileUpdateError(socket, {
          requestId,
          error: badRequest("agent:profile.update payload must be an object"),
        });
        return;
      }

      const authenticatedAgentId = socket.data.agentId;
      const tokenAgentId = socket.data.user?.agent_id;
      const userId = getUserId(socket);

      if (!authenticatedAgentId) {
        emitAgentProfileUpdateError(socket, {
          requestId,
          error: badRequest("agent:profile.update received before agent registration"),
        });
        return;
      }

      if (!tokenAgentId || tokenAgentId !== authenticatedAgentId) {
        logger.warn("agent_self_profile_socket_token_mismatch", {
          userId,
          socketId: socket.id,
          socketAgentId: authenticatedAgentId,
          tokenAgentId,
        });
        emitAgentProfileUpdateError(socket, {
          requestId,
          agentId: authenticatedAgentId,
          error: forbidden("Authenticated socket is not allowed to update this agent profile"),
        });
        return;
      }

      if (!allowAgentProfileSocketUpdate(authenticatedAgentId, socket.id)) {
        logger.warn("agent_self_profile_socket_rate_limited", {
          userId,
          socketId: socket.id,
          agentId: authenticatedAgentId,
        });
        emitAgentProfileUpdateError(socket, {
          requestId,
          agentId: authenticatedAgentId,
          error: tooManyRequests("Rate limit exceeded for agent:profile.update"),
        });
        return;
      }

      const parsed = agentSelfProfileSocketSchema.safeParse(decoded.value.data);
      if (!parsed.success) {
        emitAgentProfileUpdateError(socket, {
          requestId,
          agentId: authenticatedAgentId,
          error: badRequest(
            parsed.error.issues[0]?.message ?? "Invalid agent:profile.update payload",
          ),
        });
        return;
      }

      if (
        parsed.data.agent_id !== undefined &&
        (parsed.data.agent_id !== authenticatedAgentId || parsed.data.agent_id !== tokenAgentId)
      ) {
        logger.warn("agent_self_profile_socket_identity_mismatch", {
          userId,
          socketId: socket.id,
          socketAgentId: authenticatedAgentId,
          tokenAgentId,
          payloadAgentId: parsed.data.agent_id,
        });
        emitAgentProfileUpdateError(socket, {
          requestId,
          agentId: authenticatedAgentId,
          error: forbidden("agent:profile.update agent_id does not match the authenticated agent"),
        });
        return;
      }

      try {
        const expectedProfileVersion =
          parsed.data.expected_profile_version ?? parsed.data.profile_version;
        const dedupeKey =
          parsed.data.idempotency_key !== undefined && parsed.data.idempotency_key.trim() !== ""
            ? `idem:${parsed.data.idempotency_key.trim()}`
            : typeof requestId === "string" && requestId.trim() !== ""
              ? `socket:req:${requestId}`
              : undefined;

        const updated = await container.agentSelfProfileService.persistProfilePatch({
          agentId: authenticatedAgentId,
          patch: container.agentSelfProfileService.toPatchFromSocketPayload(parsed.data),
          source: "socket",
          ...(userId !== null ? { lastLoginUserId: userId } : {}),
          ...(expectedProfileVersion !== undefined ? { expectedProfileVersion } : {}),
          ...(dedupeKey !== undefined ? { dedupeKey } : {}),
          ...(typeof requestId === "string" ? { requestId } : {}),
          ...(parsed.data.idempotency_key !== undefined
            ? { idempotencyKey: parsed.data.idempotency_key }
            : {}),
        });

        logger.info("agent_self_profile_socket_updated", {
          userId,
          socketId: socket.id,
          agentId: updated.agentId,
        });
        emitAgentProfileUpdated(socket, requestId, {
          success: true,
          agent_id: updated.agentId,
          profileVersion: updated.profileVersion,
          profileUpdatedAt: updated.profileUpdatedAt?.toISOString() ?? null,
          agent: toAgentCatalogDto(updated),
        });
      } catch (error: unknown) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError("Internal server error", {
                statusCode: 500,
                code: "INTERNAL_SERVER_ERROR",
              });
        logger.warn("agent_self_profile_socket_failed", {
          userId,
          socketId: socket.id,
          agentId: authenticatedAgentId,
          code: appError.code,
          statusCode: appError.statusCode,
          message: appError.message,
        });
        emitAgentProfileUpdateError(socket, {
          requestId,
          agentId: authenticatedAgentId,
          error: appError,
        });
      }
    });

    socket.on(socketEvents.rpcResponse, (rawPayload: unknown, ack?: () => void) => {
      handleAgentRpcResponse(socket.id, rawPayload, ack);
    });

    socket.on(socketEvents.rpcRequestAck, (rawPayload: unknown) => {
      handleAgentRpcAck(socket.id, rawPayload);
    });

    socket.on(socketEvents.rpcBatchAck, (rawPayload: unknown) => {
      handleAgentBatchAck(socket.id, rawPayload);
    });

    socket.on(socketEvents.rpcChunk, (rawPayload: unknown) => {
      handleAgentRpcChunk(socket.id, rawPayload);
    });

    socket.on(socketEvents.rpcComplete, (rawPayload: unknown) => {
      handleAgentRpcComplete(socket.id, rawPayload);
    });

    socket.on("disconnect", () => {
      runAgentSocketDisconnectCleanup(socket, consumersNsp);
    });
  });

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
    registerConsumerSocketControlHandler({
      disconnectPrincipal: async (event) => {
        const room = `consumer:principal:${event.principalType}:${event.principalId}`;
        await disconnectConsumerSocketsInRoom(
          consumersNsp,
          room,
          buildLegacySocketAppErrorPayload(
            "ACCOUNT_BLOCKED",
            event.principalType === "client" ? "Client account is blocked" : "Account is blocked",
          ),
          {
            principalType: event.principalType,
            principalId: event.principalId,
            reason: event.reason,
          },
        );
      },
      revokeClientAccess: async (event) => {
        state.clientProfileRecipientsCacheByAgentId.delete(event.agentId);
        await disconnectConsumerSocketsInRoom(
          consumersNsp,
          buildConsumerClientAgentRoom({
            clientId: event.clientId,
            agentId: event.agentId,
          }),
          buildLegacySocketAppErrorPayload(
            "AGENT_ACCESS_REVOKED",
            `Client access to agent ${event.agentId} was revoked`,
          ),
          {
            clientId: event.clientId,
            agentId: event.agentId,
            reason: event.reason,
          },
        );
      },
      invalidateClientAgentAccessSnapshot: async (event) => {
        try {
          const sockets = await consumersNsp.in(buildClientRoomName(event.clientId)).fetchSockets();
          for (const remote of sockets) {
            clearConsumerSocketAgentAccessSnapshot(remote, event.agentId);
          }
        } catch (error: unknown) {
          logger.warn("consumer_socket_agent_access_snapshot_invalidate_failed", {
            clientId: event.clientId,
            agentId: event.agentId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      invalidateAgentAccessSnapshot: async (event) => {
        try {
          const sockets = await consumersNsp.fetchSockets();
          for (const remote of sockets) {
            clearConsumerSocketAgentAccessSnapshot(remote, event.agentId);
          }
        } catch (error: unknown) {
          logger.warn("consumer_socket_agent_access_snapshot_invalidate_by_agent_failed", {
            agentId: event.agentId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      invalidateUserAccessSnapshot: async (event) => {
        const room = `consumer:principal:user:${event.userId}`;
        try {
          const sockets = await consumersNsp.in(room).fetchSockets();
          for (const remote of sockets) {
            clearAllConsumerSocketAgentAccessSnapshots(remote);
          }
        } catch (error: unknown) {
          logger.warn("consumer_socket_agent_access_snapshot_invalidate_by_user_failed", {
            userId: event.userId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      grantClientAccess: async (event) => {
        noteConsumerClientAgentRoomGrantAttempt();
        const clientRoom = buildClientRoomName(event.clientId);
        try {
          const sockets = await consumersNsp.in(clientRoom).fetchSockets();
          for (const remote of sockets) {
            try {
              await joinConsumerClientAgentRoom(remote, {
                clientId: event.clientId,
                agentId: event.agentId,
              });
              noteConsumerClientAgentRoomGrantSocketsJoined(1);
            } catch (error: unknown) {
              noteConsumerClientAgentRoomGrantJoinFailed();
              logger.warn("consumer_socket_client_agent_room_grant_failed", {
                clientId: event.clientId,
                agentId: event.agentId,
                socketId: remote.id,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error: unknown) {
          noteConsumerClientAgentRoomGrantFetchFailed();
          logger.warn("consumer_socket_client_agent_room_grant_fetch_failed", {
            clientId: event.clientId,
            agentId: event.agentId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
  );

  state.sinkDisposers.push(
    registerConsumerSocketEventHandler({
      publish: async (event) => {
        const room = buildCustomSocketEventRoom(event.eventName);
        enforceCustomEventDistributedCountCircuit(
          state.customEventDistributedCountCircuit,
          event.eventName,
        );
        const recipientCount = await countSocketsInRoom(state, consumersNsp, room);
        if (
          !recipientCount.recipientCountBestEffort &&
          !shouldSkipCustomSocketEventZeroRecipientEarlyReturn(recipientCount) &&
          recipientCount.recipients === 0
        ) {
          return { recipients: 0 };
        }
        if (
          !recipientCount.recipientCountBestEffort &&
          env.restSocketEventMaxRecipients > 0 &&
          recipientCount.recipients > env.restSocketEventMaxRecipients
        ) {
          throw new AppError("socket event recipient fan-out limit exceeded", {
            statusCode: 503,
            code: "SERVICE_UNAVAILABLE",
            details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
          });
        }
        if (recipientCount.recipientCountBestEffort) {
          enforceCustomEventDistributedCountCircuit(
            state.customEventDistributedCountCircuit,
            event.eventName,
          );
          if (
            env.restSocketEventBestEffortLocalMaxRecipients > 0 &&
            recipientCount.recipients > env.restSocketEventBestEffortLocalMaxRecipients
          ) {
            logger.warn("socket_custom_event_publish_best_effort_local_cap_exceeded", {
              eventName: event.eventName,
              localRecipients: recipientCount.recipients,
              localCap: env.restSocketEventBestEffortLocalMaxRecipients,
            });
            throw new AppError("socket event recipient fan-out limit exceeded", {
              statusCode: 503,
              code: "SERVICE_UNAVAILABLE",
              details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
            });
          }
          noteCustomSocketEventPublishRecipientCountBestEffort();
          noteCustomSocketEventPublishRecipientCapUnverified();
          logger.warn("socket_custom_event_publish_recipient_count_best_effort", {
            eventName: event.eventName,
            localRecipients: recipientCount.recipients,
          });
        }
        let frame;
        try {
          frame = await encodePayloadFrameBridge(
            {
              eventId: event.eventId,
              eventName: event.eventName,
              emittedAt: event.emittedAt,
              publisher: event.publisher,
              payload: event.payload,
              attachments: event.attachments,
            },
            {
              ...payloadFrameEncodeOptionsFromPreference(event.payloadFrameCompression),
              requestId:
                typeof event.publishRequestId === "string" && event.publishRequestId.trim() !== ""
                  ? event.publishRequestId.trim()
                  : event.eventId,
              omitTraceId: true,
            },
          );
        } catch {
          throw new AppError("Failed to encode custom socket event PayloadFrame", {
            statusCode: 503,
            code: "SERVICE_UNAVAILABLE",
            details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
          });
        }
        consumersNsp.to(room).emit(event.eventName, frame);
        return {
          recipients: recipientCount.recipients,
          ...(recipientCount.recipientCountBestEffort ? { recipientCountBestEffort: true } : {}),
        };
      },
    }),
  );

  return io;
};
