import type { Server as HttpServer } from "node:http";

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import { Server, type Namespace, type Socket } from "socket.io";

import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "./presentation/socket/auth/socket_namespace_auth.middleware";
import { agentRegistry } from "./presentation/socket/hub/agent_registry";
import { handleAgentsCommand } from "./presentation/socket/consumers/agents_command.handler";
import { handleAgentsStreamPull } from "./presentation/socket/consumers/agents_stream_pull.handler";
import { abortPendingConsumerCommands } from "./presentation/socket/consumers/consumer_command_abort_registry";
import { resetConsumerCommandAbortRegistry } from "./presentation/socket/consumers/consumer_command_abort_registry";
import {
  cleanupAgentStreamSubscriptions,
  cleanupAgentInboundSocketState,
  cleanupConversationStreamSubscriptions,
  cleanupConsumerStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
  finalizeConversationsClosedByConsumerDisconnect,
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
  registerConsumerBridgeSocket,
  resetSocketBridgeState,
  registerSocketBridgeServer,
  unregisterAgentBridgeSocket,
  unregisterConsumerBridgeSocket,
  unregisterConsumerBridgeServer,
  unregisterSocketBridgeServer,
} from "./presentation/socket/hub/rpc_bridge";
import {
  observeRelayOverloadCheck,
  relayMetrics,
} from "./presentation/socket/hub/bridge_relay_health_metrics";
import { emitConnectionReady } from "./presentation/socket/hub/connection_ready_handshake";
import { conversationRegistry } from "./presentation/socket/hub/conversation_registry";
import {
  allowRelayConversationStartAsync,
  allowRelayRpcRequestAsync,
  clearRelayRateLimitStateByConsumerSocket,
  getRelayRateLimitMetricsSnapshot,
  resetRelayRateLimiterState,
  sweepRelayRateLimitState,
} from "./presentation/socket/hub/consumer_relay_rate_limiter";
import {
  clearAgentsCommandSocketRateLimitStateForSocketId,
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
import {
  getRelayOutboundQueueOverloadState,
  noteRelayOutboundQueueOverloadRejected,
  sweepRelayOutboundQueueState,
} from "./presentation/socket/hub/relay_outbound_queue";
import {
  handleRelayConversationStart,
  parseRelayConversationStartEnvelope,
} from "./presentation/socket/consumers/relay_conversation_start.handler";
import { handleRelayConversationEnd } from "./presentation/socket/consumers/relay_conversation_end.handler";
import {
  handleRelayRpcRequest,
  parseRelayRpcRequestEnvelope,
} from "./presentation/socket/consumers/relay_rpc_request.handler";
import {
  handleRelayRpcStreamPull,
  parseRelayRpcStreamPullEnvelope,
} from "./presentation/socket/consumers/relay_rpc_stream_pull.handler";
import {
  handleCustomSocketEventSubscribe,
  handleCustomSocketEventUnsubscribe,
} from "./presentation/socket/consumers/custom_socket_event_subscription.handler";
import { handleCustomSocketEventPublish } from "./presentation/socket/consumers/custom_socket_event_publish.handler";
import {
  type AgentProfileBroadcastEvent,
  registerAgentProfileBroadcastHandler,
} from "./application/services/agent_profile_broadcast_sink";
import type { AgentRegisterProfileSnapshot } from "./application/services/agent_profile_sync.service";
import { agentProfileReliabilityMetrics } from "./application/services/agent_profile_reliability_metrics.service";
import { registerAgentSocketControlHandler } from "./application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "./application/services/consumer_socket_control_sink";
import { registerConsumerSocketEventHandler } from "./application/services/consumer_socket_event_sink";
import {
  buildConsumerAgentProfileRoom,
  buildConsumerClientAgentRoom,
  buildConsumerClientRoom as buildClientRoomName,
  buildConsumerPrincipalRoom as buildPrincipalRoomName,
  joinConsumerClientAgentRoom,
} from "./presentation/socket/hub/consumer_identity_rooms";
import {
  resolveCustomSocketEventRoomRecipientCountStrategy,
  shouldSkipCustomSocketEventZeroRecipientEarlyReturn,
  toRoomRecipientCountFromStrategy,
} from "./presentation/socket/hub/custom_socket_event_room_recipient_count";
import { buildCustomSocketEventRoom } from "./presentation/socket/hub/custom_socket_event_rooms";
import {
  clearCustomSocketEventSubscriptionRateLimitState,
  resetCustomSocketEventSubscriptionRateLimitState,
} from "./presentation/socket/hub/custom_socket_event_subscription_limiter";
import {
  removeCustomSocketEventSubscriptionsBySocketId,
  resetCustomSocketEventSubscriptions,
} from "./presentation/socket/hub/custom_socket_event_subscription_registry";
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
  noteConsumerClientAgentRoomBootstrapCompleted,
  noteConsumerClientAgentRoomBootstrapFailed,
  noteConsumerClientAgentRoomBootstrapFetchReused,
  noteConsumerClientAgentRoomBootstrapStarted,
  noteConsumerClientAgentRoomGrantAttempt,
  noteConsumerClientAgentRoomGrantFetchFailed,
  noteConsumerClientAgentRoomGrantJoinFailed,
  noteConsumerClientAgentRoomGrantSocketsJoined,
  noteConsumerProfilePushRecipientFetchReused,
  noteConsumerClientAgentRoomReconcileDeferred,
  noteConsumerClientAgentRoomReconcileFailed,
  noteConsumerClientAgentRoomReconcileFinished,
  noteConsumerClientAgentRoomReconcileRoomsJoined,
  noteConsumerClientAgentRoomReconcileRoomsLeft,
  noteConsumerClientAgentRoomReconcileStarted,
  noteConsumerClientAgentRoomReconcileTickSkipped,
  noteCustomSocketEventPublishDistributedRecipientCountFailed,
  noteCustomSocketEventPublishDistributedRecipientCountCircuitClosed,
  noteCustomSocketEventPublishDistributedRecipientCountCircuitOpened,
  noteCustomSocketEventPublishDistributedRecipientCountCircuitRejected,
  noteCustomSocketEventPublishDistributedRecipientCountSkipped,
  noteCustomSocketEventPublishRecipientCapUnverified,
  noteCustomSocketEventPublishRecipientCountBestEffort,
  noteCustomSocketEventSubscriptionsRemoved,
  noteAgentRoomDisconnectTriggered,
  noteConsumerPendingCommandsAborted,
  noteConsumerProfilePushBatch,
  noteConsumerProfilePushCoalesced,
  noteConsumerRoomDisconnectTriggered,
  noteConsumerSocketConnected,
  noteConsumerSocketDisconnected,
  resetSocketConsumerMetrics,
} from "./shared/metrics/socket_consumer.metrics";
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
  payloadFrameEncodeOptionsFromPreference,
} from "./shared/utils/payload_frame";
import { agentSelfProfileSocketSchema } from "./presentation/http/validators/agent_self_profile.validator";
import { agentRegisterPayloadSchema } from "./shared/validators/agent_register";
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
import { isSocketIoRedisAdapterActive } from "./infrastructure/redis/socket_io_redis_adapter";
import { parseAgentReadyPayload } from "./presentation/socket/hub/agent_ready_payload";

type SocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: Record<string, unknown>;
  agentRegisterProfileSnapshot?: AgentRegisterProfileSnapshot;
};

type HubSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

type PendingAgentProfilePush = {
  event: AgentProfileBroadcastEvent;
  timeoutHandle: NodeJS.Timeout;
};

type DistributedCountCircuitState = {
  consecutiveFailures: number;
  openedUntilEpochMs: number;
};

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
  readonly pendingAgentProfilePushByAgentId: Map<string, PendingAgentProfilePush>;
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

const clientAgentProfilePushDebounceMs = 25;
const socketServerStates = new WeakMap<Server, SocketServerState>();
const activeSocketServers: Server[] = [];

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
  customEventDistributedCountCircuit: {
    consecutiveFailures: 0,
    openedUntilEpochMs: 0,
  },
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

const buildConsumerOverloadError = (
  retryAfterMs: number,
  reason: string,
): { code: string; message: string; statusCode: number; retryAfterMs: number } => ({
  code: "SERVICE_UNAVAILABLE",
  message: `Consumer namespace temporarily overloaded (${reason})`,
  statusCode: 503,
  retryAfterMs,
});

const getUserId = (socket: HubSocket): string | null => {
  return typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;
};

const buildConsumerPrincipalRoom = (user: JwtAccessPayload | undefined): string | null => {
  if (typeof user?.sub !== "string" || user.sub.trim() === "") {
    return null;
  }
  const principalType = user.principal_type === "client" ? "client" : "user";
  return buildPrincipalRoomName({ principalType, principalId: user.sub });
};

const buildConsumerClientRoom = (user: JwtAccessPayload | undefined): string | null => {
  return user?.principal_type === "client" && typeof user.sub === "string" && user.sub.trim() !== ""
    ? buildClientRoomName(user.sub)
    : null;
};

const listConsumerApprovedAgentRooms = (
  clientId: string,
  approvedAgentIds: readonly string[],
): string[] => {
  const rooms = new Set<string>();
  for (const agentId of approvedAgentIds) {
    rooms.add(
      buildConsumerClientAgentRoom({
        clientId,
        agentId,
      }),
    );
    rooms.add(buildConsumerAgentProfileRoom(agentId));
  }
  return [...rooms];
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

const isCustomEventDistributedCountCircuitOpen = (
  state: SocketServerState,
  nowEpochMs = Date.now(),
): boolean => state.customEventDistributedCountCircuit.openedUntilEpochMs > nowEpochMs;

const hasOtherOpenCustomEventDistributedCountCircuit = (
  currentState: SocketServerState,
  nowEpochMs = Date.now(),
): boolean => {
  for (const server of activeSocketServers) {
    const state = socketServerStates.get(server);
    if (!state || state === currentState) {
      continue;
    }
    if (isCustomEventDistributedCountCircuitOpen(state, nowEpochMs)) {
      return true;
    }
  }
  return false;
};

const resetCustomEventDistributedCountCircuit = (
  state: SocketServerState,
  nowEpochMs = Date.now(),
): void => {
  const wasOpen = isCustomEventDistributedCountCircuitOpen(state, nowEpochMs);
  state.customEventDistributedCountCircuit.consecutiveFailures = 0;
  state.customEventDistributedCountCircuit.openedUntilEpochMs = 0;
  if (wasOpen && !hasOtherOpenCustomEventDistributedCountCircuit(state, nowEpochMs)) {
    noteCustomSocketEventPublishDistributedRecipientCountCircuitClosed();
  }
};

const recordCustomEventDistributedCountFailure = (
  state: SocketServerState,
  nowEpochMs = Date.now(),
): void => {
  const circuit = state.customEventDistributedCountCircuit;
  circuit.consecutiveFailures += 1;
  if (
    !isCustomEventDistributedCountCircuitOpen(state, nowEpochMs) &&
    circuit.consecutiveFailures >= env.restSocketEventDistributedCountFailureThreshold
  ) {
    circuit.openedUntilEpochMs = nowEpochMs + env.restSocketEventDistributedCountFailureOpenMs;
    noteCustomSocketEventPublishDistributedRecipientCountCircuitOpened();
  }
};

const enforceCustomEventDistributedCountCircuit = (
  state: SocketServerState,
  eventName: string,
): void => {
  const nowEpochMs = Date.now();
  if (
    state.customEventDistributedCountCircuit.openedUntilEpochMs > 0 &&
    !isCustomEventDistributedCountCircuitOpen(state, nowEpochMs)
  ) {
    resetCustomEventDistributedCountCircuit(state, nowEpochMs);
  }
  if (!isCustomEventDistributedCountCircuitOpen(state, nowEpochMs)) {
    return;
  }
  noteCustomSocketEventPublishDistributedRecipientCountCircuitRejected();
  logger.warn("socket_custom_event_publish_distributed_count_circuit_open", {
    eventName,
    circuitOpenUntilEpochMs: state.customEventDistributedCountCircuit.openedUntilEpochMs,
  });
  throw new AppError("socket event distributed recipient count temporarily unavailable", {
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
    details: { retry_after_ms: env.restSocketEventFanoutRetryAfterMs },
  });
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

const joinConsumerIdentityRooms = async (socket: HubSocket): Promise<void> => {
  const user = socket.data.user;
  const rooms = [buildConsumerPrincipalRoom(user), buildConsumerClientRoom(user)].filter(
    (room): room is string => room !== null,
  );
  if (rooms.length === 0) {
    return;
  }
  await socket.join(rooms);
};

const buildConsumerClientAgentRoomPrefix = (clientId: string): string =>
  `consumer:client-agent:${clientId}:`;

const buildConsumerAgentProfileRoomPrefix = (): string => "consumer:agent-profile:";

export const selectReconcileClientEntries = <T>(
  entries: readonly T[],
  cursor: number,
  maxClientsPerTick: number,
): {
  readonly selected: readonly T[];
  readonly nextCursor: number;
  readonly deferredCount: number;
} => {
  if (entries.length === 0) {
    return { selected: [], nextCursor: 0, deferredCount: 0 };
  }

  const size = Math.min(entries.length, Math.max(1, maxClientsPerTick));
  const normalizedCursor = ((cursor % entries.length) + entries.length) % entries.length;
  const ordered = [...entries.slice(normalizedCursor), ...entries.slice(0, normalizedCursor)];
  return {
    selected: ordered.slice(0, size),
    nextCursor: (normalizedCursor + size) % entries.length,
    deferredCount: entries.length - size,
  };
};

export const resolveConsumerClientAgentRoomReconcileStartDelayMs = (
  maxJitterMs: number,
  randomValue = Math.random(),
): number => {
  if (maxJitterMs <= 0) {
    return 0;
  }
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  return Math.floor(normalizedRandom * (maxJitterMs + 1));
};

const forEachWithConcurrencyLimit = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  const maxConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  await Promise.all(
    Array.from({ length: maxConcurrency }, async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        await worker(items[currentIndex]!);
      }
    }),
  );
};

const reconcileConsumerClientAgentRoomsForSocket = async (
  socket: HubSocket,
  clientId: string,
  approvedAgentIds: readonly string[],
): Promise<{ joined: number; left: number }> => {
  if (!socket.connected) {
    return { joined: 0, left: 0 };
  }

  const expectedRooms = new Set(listConsumerApprovedAgentRooms(clientId, approvedAgentIds));
  const currentRooms = [...socket.rooms].filter((room) =>
    room.startsWith(buildConsumerClientAgentRoomPrefix(clientId)) ||
    room.startsWith(buildConsumerAgentProfileRoomPrefix()),
  );

  let joined = 0;
  let left = 0;

  for (const room of currentRooms) {
    if (!expectedRooms.has(room)) {
      await socket.leave(room);
      left += 1;
    }
  }

  for (const room of expectedRooms) {
    if (!socket.rooms.has(room)) {
      await socket.join(room);
      joined += 1;
    }
  }

  return { joined, left };
};

const reconcileConsumerClientAgentRooms = async (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  state: SocketServerState,
): Promise<void> => {
  if (state.shuttingDown) {
    return;
  }

  const socketsByClientId = new Map<string, HubSocket[]>();
  for (const socket of namespace.sockets.values()) {
    if (socket.data.user?.principal_type !== "client") {
      continue;
    }
    const clientId = socket.data.user.sub?.trim();
    if (!clientId) {
      continue;
    }
    const existing = socketsByClientId.get(clientId);
    if (existing !== undefined) {
      existing.push(socket);
      continue;
    }
    socketsByClientId.set(clientId, [socket]);
  }

  if (socketsByClientId.size === 0) {
    return;
  }

  const selectedBatch = selectReconcileClientEntries(
    [...socketsByClientId.entries()].sort(([leftClientId], [rightClientId]) =>
      leftClientId.localeCompare(rightClientId),
    ),
    state.consumerClientAgentRoomReconcileCursor,
    env.socketConsumerClientAgentRoomReconcileMaxClientsPerTick,
  );
  state.consumerClientAgentRoomReconcileCursor = selectedBatch.nextCursor;
  if (selectedBatch.deferredCount > 0) {
    noteConsumerClientAgentRoomReconcileDeferred(selectedBatch.deferredCount);
  }

  const socketCount = selectedBatch.selected.reduce((sum, [, sockets]) => sum + sockets.length, 0);
  noteConsumerClientAgentRoomReconcileStarted(selectedBatch.selected.length, socketCount);

  try {
    await forEachWithConcurrencyLimit(
      selectedBatch.selected,
      env.socketConsumerClientAgentRoomReconcileConcurrency,
      async ([clientId, sockets]) => {
        try {
          const approvedAgentIds =
            await container.clientAgentAccessService.listApprovedAgentIds(clientId);
          for (const socket of sockets) {
            const result = await reconcileConsumerClientAgentRoomsForSocket(
              socket,
              clientId,
              approvedAgentIds,
            );
            if (result.joined > 0) {
              noteConsumerClientAgentRoomReconcileRoomsJoined(result.joined);
            }
            if (result.left > 0) {
              noteConsumerClientAgentRoomReconcileRoomsLeft(result.left);
            }
          }
        } catch (error: unknown) {
          noteConsumerClientAgentRoomReconcileFailed();
          logger.warn("consumer_socket_client_agent_room_reconcile_failed", {
            clientId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  } finally {
    noteConsumerClientAgentRoomReconcileFinished();
  }
};

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

const countSocketsInRoom = async (
  state: SocketServerState,
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
): Promise<RoomRecipientCount> => {
  const localRecipients = countLocalSocketsInRoom(namespace, room);
  const redisAdapterActive = isSocketIoRedisAdapterActive();
  const strategy = resolveCustomSocketEventRoomRecipientCountStrategy({
    redisAdapterActive,
    localRecipients,
    maxRecipients: env.restSocketEventMaxRecipients,
  });

  if (strategy.kind !== "fetch_distributed") {
    resetCustomEventDistributedCountCircuit(state);
    if (redisAdapterActive) {
      noteCustomSocketEventPublishDistributedRecipientCountSkipped();
    }
    return toRoomRecipientCountFromStrategy(strategy);
  }

  try {
    const recipients = (await namespace.in(room).fetchSockets()).length;
    resetCustomEventDistributedCountCircuit(state);
    return {
      recipients,
      recipientCountBestEffort: false,
      recipientCountLocalOnly: false,
    };
  } catch (error: unknown) {
    noteCustomSocketEventPublishDistributedRecipientCountFailed();
    recordCustomEventDistributedCountFailure(state);
    logger.warn("socket_room_distributed_count_failed_fallback_local", {
      room,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      recipients: localRecipients,
      recipientCountBestEffort: true,
      recipientCountLocalOnly: false,
    };
  }
};

const countLocalSocketsInRoom = (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
): number => namespace.adapter.rooms.get(room)?.size ?? 0;

const clearConsumerProfilePushState = (state: SocketServerState): void => {
  for (const pending of state.pendingAgentProfilePushByAgentId.values()) {
    clearTimeout(pending.timeoutHandle);
  }
  state.pendingAgentProfilePushByAgentId.clear();
  state.pendingApprovedAgentIdsByClientId.clear();
  state.profilePushRecipientsInFlightByAgentId.clear();
  state.clientProfileRecipientsCacheByAgentId.clear();
  resetCustomEventDistributedCountCircuit(state);
};

const logSocketLifecycleInfo = (event: string, payload: Record<string, unknown>): void => {
  if (env.nodeEnv === "production") {
    logger.debug(event, payload);
    return;
  }
  logger.info(event, payload);
};

const backfillConsumerApprovedAgentRooms = async (
  state: SocketServerState,
  socket: HubSocket,
): Promise<void> => {
  if (state.shuttingDown) {
    return;
  }

  const user = socket.data.user;
  if (user?.principal_type !== "client" || typeof user.sub !== "string" || user.sub.trim() === "") {
    return;
  }
  const startedAt = noteConsumerClientAgentRoomBootstrapStarted();
  try {
    const clientId = user.sub.trim();
    const existingFetch = state.pendingApprovedAgentIdsByClientId.get(clientId);
    if (existingFetch) {
      noteConsumerClientAgentRoomBootstrapFetchReused();
    }
    const approvedAgentIds =
      existingFetch ??
      (async (): Promise<readonly string[]> => {
        try {
          return await container.clientAgentAccessService.listApprovedAgentIds(clientId);
        } finally {
          state.pendingApprovedAgentIdsByClientId.delete(clientId);
        }
      })();
    if (!existingFetch) {
      state.pendingApprovedAgentIdsByClientId.set(clientId, approvedAgentIds);
    }
    const result = await reconcileConsumerClientAgentRoomsForSocket(
      socket,
      clientId,
      await approvedAgentIds,
    );
    if (result.joined > 0) {
      noteConsumerClientAgentRoomReconcileRoomsJoined(result.joined);
    }
    if (result.left > 0) {
      noteConsumerClientAgentRoomReconcileRoomsLeft(result.left);
    }
    noteConsumerClientAgentRoomBootstrapCompleted(startedAt);
  } catch (error: unknown) {
    noteConsumerClientAgentRoomBootstrapFailed();
    logger.warn("consumer_socket_client_agent_room_bootstrap_failed", {
      socketId: socket.id,
      userId: getUserId(socket),
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const getCachedProfilePushRecipients = async (
  state: SocketServerState,
  agentId: string,
): Promise<readonly string[]> => {
  const cached = state.clientProfileRecipientsCacheByAgentId.get(agentId);
  if (cached !== undefined) {
    return cached;
  }

  const existingFetch = state.profilePushRecipientsInFlightByAgentId.get(agentId);
  if (existingFetch) {
    noteConsumerProfilePushRecipientFetchReused();
    return existingFetch;
  }

  const fetchPromise = (async (): Promise<readonly string[]> => {
    try {
      const clientIds =
        await container.clientAgentAccessService.listActiveApprovedClientIdsForAgent(agentId);
      state.clientProfileRecipientsCacheByAgentId.set(agentId, clientIds);
      return clientIds;
    } finally {
      state.profilePushRecipientsInFlightByAgentId.delete(agentId);
    }
  })();
  state.profilePushRecipientsInFlightByAgentId.set(agentId, fetchPromise);
  return fetchPromise;
};

const flushAgentProfilePush = async (
  state: SocketServerState,
  agentId: string,
): Promise<void> => {
  if (state.shuttingDown) {
    return;
  }

  const pending = state.pendingAgentProfilePushByAgentId.get(agentId);
  if (!pending) {
    return;
  }
  state.pendingAgentProfilePushByAgentId.delete(agentId);

  const recipientRoom = buildConsumerAgentProfileRoom(agentId);
  const cachedRecipients = state.clientProfileRecipientsCacheByAgentId.get(agentId);
  noteConsumerProfilePushBatch(
    cachedRecipients?.length ?? countLocalSocketsInRoom(state.consumersNamespace, recipientRoom),
  );

  const frame = encodePayloadFrame(
    {
      success: true,
      agent_id: pending.event.agentId,
      profile_version: pending.event.profileVersion,
      profileUpdatedAt: pending.event.profileUpdatedAt,
      changed_fields: pending.event.changedFields,
      source: pending.event.source,
    },
    { omitTraceId: true },
  );
  state.consumersNamespace.to(recipientRoom).emit(socketEvents.clientAgentProfileUpdated, frame);
};

const scheduleAgentProfilePush = (
  state: SocketServerState,
  event: AgentProfileBroadcastEvent,
): void => {
  if (state.shuttingDown) {
    return;
  }

  const existing = state.pendingAgentProfilePushByAgentId.get(event.agentId);
  if (existing) {
    existing.event = event;
    noteConsumerProfilePushCoalesced();
    return;
  }

  if (state.clientProfileRecipientsCacheByAgentId.get(event.agentId) === undefined) {
    void getCachedProfilePushRecipients(state, event.agentId).catch((error: unknown) => {
      logger.warn("client_agent_profile_push_recipient_cache_prime_failed", {
        agentId: event.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const timeoutHandle = setTimeout(() => {
    const flushPromise = flushAgentProfilePush(state, event.agentId).catch((error: unknown) => {
      logger.warn("client_agent_profile_push_failed", {
        agentId: event.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    state.profilePushFlushInFlight.add(flushPromise);
    void flushPromise.finally(() => {
      state.profilePushFlushInFlight.delete(flushPromise);
    });
  }, clientAgentProfilePushDebounceMs);
  timeoutHandle.unref?.();
  state.pendingAgentProfilePushByAgentId.set(event.agentId, {
    event,
    timeoutHandle,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const resolveRequiresExplicitProtocolReadyAck = (
  capabilities: Record<string, unknown>,
): boolean => {
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
    logSocketLifecycleInfo("Agent disconnected from hub", {
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
  unregisterConsumerBridgeSocket(socket.id);
  const abortedCommands = abortPendingConsumerCommands(socket.id);
  const removedCustomEventSubscriptions = removeCustomSocketEventSubscriptionsBySocketId(
    socket.id,
  );
  clearCustomSocketEventSubscriptionRateLimitState(socket.id);
  if (removedCustomEventSubscriptions > 0) {
    noteCustomSocketEventSubscriptionsRemoved(removedCustomEventSubscriptions);
  }
  noteConsumerSocketDisconnected(socket.data.user?.principal_type ?? null);
  cleanupConsumerStreamSubscriptions(socket.id);
  clearRelayRateLimitStateByConsumerSocket(socket.id);
  clearAgentsCommandSocketRateLimitStateForSocketId(socket.id);
  clearAgentProfileSocketRateLimitStateForSocketId(socket.id);
  const endedConversations = conversationRegistry.removeByConsumerSocketId(socket.id);
  finalizeConversationsClosedByConsumerDisconnect(endedConversations, (conversation) => {
    const agentSocket = agentsNsp.sockets.get(conversation.agentSocketId);
    agentSocket?.emit(
      socketEvents.relayConversationEnded,
      buildRelayConversationEndedPayload(conversation.conversationId, "consumer_disconnected"),
    );
  });
  if (abortedCommands > 0) {
    noteConsumerPendingCommandsAborted(abortedCommands);
    logger.info("consumer_socket_pending_commands_aborted", {
      socketId: socket.id,
      abortedCommands,
    });
  }
};

export let agentsNamespace: ReturnType<Server["of"]> | null = null;
const resolveCurrentSocketServer = (): Server | null =>
  activeSocketServers.length > 0 ? activeSocketServers[activeSocketServers.length - 1]! : null;

const registerActiveSocketServer = (io: Server): void => {
  activeSocketServers.push(io);
  agentsNamespace = socketServerStates.get(io)?.agentsNamespace ?? null;
};

const unregisterActiveSocketServer = (io: Server): void => {
  const index = activeSocketServers.lastIndexOf(io);
  if (index >= 0) {
    activeSocketServers.splice(index, 1);
  }
  const current = resolveCurrentSocketServer();
  agentsNamespace = current ? socketServerStates.get(current)?.agentsNamespace ?? null : null;
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

  clearConsumerProfilePushState(state);
};

export const stopSocketServerLifecycleTasksForTests = stopSocketServerLifecycleTasks;

const scheduleConsumerClientAgentRoomReconcile = (
  state: SocketServerState,
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
): void => {
  const runTick = (): void => {
    if (state.shuttingDown) {
      return;
    }
    if (state.consumerClientAgentRoomReconcileInFlight !== null) {
      noteConsumerClientAgentRoomReconcileTickSkipped();
      return;
    }
    state.consumerClientAgentRoomReconcileInFlight = reconcileConsumerClientAgentRooms(
      namespace,
      state,
    )
      .catch((error: unknown) => {
        logger.warn("consumer_socket_client_agent_room_reconcile_tick_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.consumerClientAgentRoomReconcileInFlight = null;
      });
  };

  const startInterval = (): void => {
    runTick();
    state.consumerClientAgentRoomReconcileTimer = setInterval(
      runTick,
      env.socketConsumerClientAgentRoomReconcileIntervalMs,
    );
    state.consumerClientAgentRoomReconcileTimer.unref?.();
  };

  const jitterMs = env.socketConsumerClientAgentRoomReconcileStartJitterMs;
  if (jitterMs <= 0) {
    startInterval();
    return;
  }

  state.consumerClientAgentRoomReconcileStartTimeout = setTimeout(
    startInterval,
    resolveConsumerClientAgentRoomReconcileStartDelayMs(jitterMs),
  );
  state.consumerClientAgentRoomReconcileStartTimeout.unref?.();
};

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
    conversationRegistry.clear();
    agentRegistry.clear();
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
    for (const conversation of expiredConversations) {
      cleanupConversationStreamSubscriptions(conversation.conversationId);
      const consumerSocket = consumersNsp.sockets.get(conversation.consumerSocketId);
      consumerSocket?.emit(socketEvents.relayConversationEnded, {
        success: true,
        conversationId: conversation.conversationId,
        reason: "expired",
      });
    }
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
    logSocketLifecycleInfo("Socket client connected", {
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

      logSocketLifecycleInfo("Agent registered on hub", {
        socketId: socket.id,
        agentId,
        userId,
      });

      socket.emit(
        socketEvents.agentCapabilities,
        encodePayloadFrame(
          {
            capabilities: buildHubServerCapabilities({
              recommendedStreamPullWindowSize: env.socketRestStreamPullWindowSize,
              maxStreamPullWindowSize: env.socketRestStreamPullMaxWindowSize,
            }),
          },
          { ...withOptionalRequestId(decoded.value.frame.requestId), omitTraceId: true },
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
        encodePayloadFrame(
          {
            agent_id: currentAgentId,
            timestamp: new Date().toISOString(),
            status: "ok",
          },
          { ...withOptionalRequestId(decoded.value.frame.requestId), omitTraceId: true },
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

  consumersNsp.on("connection", async (socket: HubSocket) => {
    registerConsumerBridgeSocket(consumersNsp, socket.id);
    logSocketLifecycleInfo("Consumer socket connected", {
      socketId: socket.id,
      userId: getUserId(socket),
    });
    noteConsumerSocketConnected(socket.data.user?.principal_type ?? null);

    try {
      await joinConsumerIdentityRooms(socket);
    } catch (error: unknown) {
      logger.warn("consumer_socket_identity_room_join_failed", {
        socketId: socket.id,
        userId: getUserId(socket),
        message: error instanceof Error ? error.message : String(error),
      });
      unregisterConsumerBridgeSocket(socket.id);
      socket.emit(
        socketEvents.appError,
        buildLegacySocketAppErrorPayload(
          "CONSUMER_SOCKET_INITIALIZATION_FAILED",
          "Consumer socket initialization failed",
        ),
      );
      noteConsumerSocketDisconnected(socket.data.user?.principal_type ?? null);
      socket.disconnect(true);
      return;
    }

    emitConnectionReady(socket, {
      id: socket.id,
      message: "Consumer socket connected successfully",
      user: socket.data.user ?? null,
    });
    void backfillConsumerApprovedAgentRooms(state, socket);

    socket.on(socketEvents.agentsCommand, (rawPayload: unknown) => {
      handleAgentsCommand(socket, rawPayload);
    });

    socket.on(socketEvents.agentsStreamPull, (rawPayload: unknown) => {
      handleAgentsStreamPull(socket, rawPayload);
    });

    socket.on(socketEvents.relayConversationStart, (rawPayload: unknown) => {
      void (async (): Promise<void> => {
        const tOverload = performance.now();
        const overload = getRelayOutboundQueueOverloadState();
        observeRelayOverloadCheck(performance.now() - tOverload);
        if (overload.overloaded) {
          noteRelayOutboundQueueOverloadRejected();
          socket.emit(socketEvents.relayConversationStarted, {
            success: false,
            error: buildConsumerOverloadError(
              overload.retryAfterMs,
              overload.reason ?? "relay_outbound_queue",
            ),
          });
          return;
        }

        // Pre-validate envelope BEFORE consuming rate-limit budget; malformed
        // payloads should not burn quota (self-DoS).
        const envelope = parseRelayConversationStartEnvelope(rawPayload);
        if (!envelope.success) {
          socket.emit(socketEvents.relayConversationStarted, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
          });
          return;
        }

        const userSub = socket.data.user?.sub;
        if (!(await allowRelayConversationStartAsync(userSub, socket.id))) {
          socket.emit(socketEvents.relayConversationStarted, {
            success: false,
            error: {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded for relay:conversation.start",
              statusCode: 429,
            },
          });
          return;
        }

        await handleRelayConversationStart(socket, rawPayload);
      })().catch((error: unknown) => {
        logger.warn("relay_conversation_start_handler_failed", {
          socketId: socket.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    socket.on(socketEvents.relayConversationEnd, (rawPayload: unknown) => {
      handleRelayConversationEnd(socket, rawPayload);
    });

    socket.on(socketEvents.relayRpcRequest, (rawPayload: unknown) => {
      void (async (): Promise<void> => {
        const tOverload = performance.now();
        const overload = getRelayOutboundQueueOverloadState();
        observeRelayOverloadCheck(performance.now() - tOverload);
        if (overload.overloaded) {
          noteRelayOutboundQueueOverloadRejected();
          socket.emit(socketEvents.relayRpcAccepted, {
            success: false,
            error: buildConsumerOverloadError(
              overload.retryAfterMs,
              overload.reason ?? "relay_outbound_queue",
            ),
          });
          return;
        }

        // Pre-validate envelope BEFORE consuming rate-limit budget.
        const envelope = parseRelayRpcRequestEnvelope(rawPayload);
        if (!envelope.success) {
          socket.emit(socketEvents.relayRpcAccepted, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
          });
          return;
        }

        const userSub = socket.data.user?.sub;
        if (!(await allowRelayRpcRequestAsync(userSub, socket.id))) {
          socket.emit(socketEvents.relayRpcAccepted, {
            success: false,
            error: {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded for relay:rpc.request",
              statusCode: 429,
            },
          });
          return;
        }

        handleRelayRpcRequest(socket, rawPayload);
      })().catch((error: unknown) => {
        logger.warn("relay_rpc_request_handler_failed", {
          socketId: socket.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    socket.on(socketEvents.relayRpcStreamPull, (rawPayload: unknown) => {
      const tOverload = performance.now();
      const overload = getRelayOutboundQueueOverloadState();
      observeRelayOverloadCheck(performance.now() - tOverload);
      if (overload.overloaded) {
        noteRelayOutboundQueueOverloadRejected();
        socket.emit(socketEvents.relayRpcStreamPullResponse, {
          success: false,
          error: buildConsumerOverloadError(
            overload.retryAfterMs,
            overload.reason ?? "relay_outbound_queue",
          ),
        });
        return;
      }

      // Pre-validate envelope BEFORE entering the handler. Stream-pull credit
      // rate limit lives inside the handler (after preparing the pull, before
      // executing it), so envelope validation is the only pre-step here.
      const envelope = parseRelayRpcStreamPullEnvelope(rawPayload);
      if (!envelope.success) {
        socket.emit(socketEvents.relayRpcStreamPullResponse, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
        });
        return;
      }

      handleRelayRpcStreamPull(socket, rawPayload);
    });

    socket.on(socketEvents.socketEventSubscribe, (rawPayload: unknown) => {
      handleCustomSocketEventSubscribe(socket, rawPayload);
    });

    socket.on(socketEvents.socketEventUnsubscribe, (rawPayload: unknown) => {
      handleCustomSocketEventUnsubscribe(socket, rawPayload);
    });

    socket.on(socketEvents.socketEventPublish, (rawPayload: unknown) => {
      handleCustomSocketEventPublish(socket, rawPayload);
    });

    socket.on("disconnect", () => {
      runConsumerSocketDisconnectCleanup(socket, agentsNsp);
    });
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
        enforceCustomEventDistributedCountCircuit(state, event.eventName);
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
          enforceCustomEventDistributedCountCircuit(state, event.eventName);
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
