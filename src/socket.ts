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
  dispatchRpcCommandToAgent,
  getRelayMetricsSnapshot,
  handleAgentBatchAck,
  handleAgentRpcAck,
  handleAgentRpcChunk,
  handleAgentRpcComplete,
  handleAgentRpcResponse,
  registerConsumerBridgeServer,
  resetSocketBridgeState,
  registerSocketBridgeServer,
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
import { registerAgentSocketControlHandler } from "./application/services/agent_socket_control_sink";
import { registerConsumerSocketControlHandler } from "./application/services/consumer_socket_control_sink";
import { registerConsumerSocketEventHandler } from "./application/services/consumer_socket_event_sink";
import {
  buildConsumerClientAgentRoom,
  buildConsumerClientRoom as buildClientRoomName,
  buildConsumerPrincipalRoom as buildPrincipalRoomName,
} from "./presentation/socket/hub/consumer_identity_rooms";
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
import { buildCorsOptions } from "./shared/config/cors";
import { env } from "./shared/config/env";
import { AppError } from "./shared/errors/app_error";
import { badRequest, forbidden, tooManyRequests } from "./shared/errors/http_errors";
import { buildHubServerCapabilities } from "./shared/constants/agent_transport_contract";
import { socketEvents, SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import { container } from "./shared/di/container";
import {
  getSocketConsumerMetricsSnapshot,
  noteCustomSocketEventSubscriptionsRemoved,
  noteConsumerPendingCommandsAborted,
  noteConsumerProfilePushBatch,
  noteConsumerProfilePushCoalesced,
  noteConsumerSocketConnected,
  noteConsumerSocketDisconnected,
  resetSocketConsumerMetrics,
} from "./shared/metrics/socket_consumer.metrics";
import {
  getSocketAgentMetricsSnapshot,
  noteAgentCapabilityProfile,
  noteAgentRegisterRateLimited,
  noteAgentSessionRejectedActive,
  noteAgentSessionTakeoverDisconnect,
  resetSocketAgentMetrics,
} from "./shared/metrics/socket_agent.metrics";
import type { JwtAccessPayload } from "./shared/utils/jwt";
import { logger } from "./shared/utils/logger";
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

type SocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: Record<string, unknown>;
};

type HubSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

type CachedClientProfileRecipients = {
  readonly clientIds: readonly string[];
  readonly expiresAtMs: number;
};

type PendingAgentProfilePush = {
  event: AgentProfileBroadcastEvent;
  timeoutHandle: NodeJS.Timeout;
};

const clientProfileRecipientsCacheByAgentId = new Map<string, CachedClientProfileRecipients>();
const pendingAgentProfilePushByAgentId = new Map<string, PendingAgentProfilePush>();
const clientAgentProfilePushDebounceMs = 25;
const clientAgentProfileRecipientsCacheTtlMs = 1_000;

const emitAppError = (socket: HubSocket, message: string): void => {
  socket.emit(socketEvents.appError, {
    message,
    code: "SOCKET_PROTOCOL_ERROR",
  });
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

const disconnectAgentSocketsInRoom = async (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
  payload: { code: string; message: string },
  logContext: Record<string, unknown>,
): Promise<number> => {
  const sockets = await namespace.in(room).fetchSockets();
  for (const socket of sockets) {
    socket.emit(socketEvents.appError, payload);
    socket.disconnect(true);
  }
  if (sockets.length > 0) {
    logger.info("agent_socket_sessions_disconnected", {
      room,
      disconnectedCount: sockets.length,
      ...logContext,
    });
  }
  return sockets.length;
};

const joinConsumerIdentityRooms = async (socket: HubSocket): Promise<void> => {
  const user = socket.data.user;
  const rooms = [buildConsumerPrincipalRoom(user), buildConsumerClientRoom(user)].filter(
    (room): room is string => room !== null,
  );
  if (user?.principal_type === "client" && typeof user.sub === "string" && user.sub.trim() !== "") {
    const agentIds = await container.clientAgentAccessService.listApprovedAgentIds(user.sub);
    rooms.push(
      ...agentIds.map((agentId) =>
        buildConsumerClientAgentRoom({
          clientId: user.sub,
          agentId,
        }),
      ),
    );
  }
  if (rooms.length === 0) {
    return;
  }
  await socket.join(rooms);
};

const disconnectConsumerSocketsInRoom = async (
  namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  room: string,
  payload: { code: string; message: string },
  logContext: Record<string, unknown>,
): Promise<number> => {
  const sockets = await namespace.in(room).fetchSockets();
  for (const socket of sockets) {
    socket.emit(socketEvents.appError, payload);
    socket.disconnect(true);
  }
  if (sockets.length > 0) {
    logger.info("consumer_socket_sessions_disconnected", {
      room,
      disconnectedCount: sockets.length,
      ...logContext,
    });
  }
  return sockets.length;
};

const clearConsumerProfilePushState = (): void => {
  for (const pending of pendingAgentProfilePushByAgentId.values()) {
    clearTimeout(pending.timeoutHandle);
  }
  pendingAgentProfilePushByAgentId.clear();
  clientProfileRecipientsCacheByAgentId.clear();
};

const logSocketLifecycleInfo = (event: string, payload: Record<string, unknown>): void => {
  if (env.nodeEnv === "production") {
    logger.debug(event, payload);
    return;
  }
  logger.info(event, payload);
};

const getCachedProfilePushRecipients = async (agentId: string): Promise<readonly string[]> => {
  const cached = clientProfileRecipientsCacheByAgentId.get(agentId);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.clientIds;
  }

  const clientIds =
    await container.clientAgentAccessService.listActiveApprovedClientIdsForAgent(agentId);
  clientProfileRecipientsCacheByAgentId.set(agentId, {
    clientIds,
    expiresAtMs: Date.now() + clientAgentProfileRecipientsCacheTtlMs,
  });
  return clientIds;
};

const flushAgentProfilePush = async (
  consumersNamespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  agentId: string,
): Promise<void> => {
  const pending = pendingAgentProfilePushByAgentId.get(agentId);
  if (!pending) {
    return;
  }
  pendingAgentProfilePushByAgentId.delete(agentId);

  const clientIds = await getCachedProfilePushRecipients(agentId);
  if (clientIds.length === 0) {
    return;
  }
  noteConsumerProfilePushBatch(clientIds.length);

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
  for (const clientId of clientIds) {
    consumersNamespace.to(`client:${clientId}`).emit(socketEvents.clientAgentProfileUpdated, frame);
  }
};

const scheduleAgentProfilePush = (
  consumersNamespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  event: AgentProfileBroadcastEvent,
): void => {
  const existing = pendingAgentProfilePushByAgentId.get(event.agentId);
  if (existing) {
    existing.event = event;
    noteConsumerProfilePushCoalesced();
    return;
  }

  const timeoutHandle = setTimeout(() => {
    void flushAgentProfilePush(consumersNamespace, event.agentId).catch((error: unknown) => {
      logger.warn("client_agent_profile_push_failed", {
        agentId: event.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, clientAgentProfilePushDebounceMs);
  timeoutHandle.unref?.();
  pendingAgentProfilePushByAgentId.set(event.agentId, {
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

const clearAgentProfileSyncState = (agentId: string): void => {
  const timer = agentProfileSyncTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    agentProfileSyncTimers.delete(agentId);
  }
  agentProfileSyncAttempts.delete(agentId);
};

const scheduleAgentProfileSync = (
  input: {
    readonly agentId: string;
    readonly userId: string | null;
  },
  delayMs = 1_200,
): void => {
  const attempt = (agentProfileSyncAttempts.get(input.agentId) ?? 0) + 1;
  agentProfileSyncAttempts.set(input.agentId, attempt);

  const existing = agentProfileSyncTimers.get(input.agentId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(
    () => {
      agentProfileSyncTimers.delete(input.agentId);
      void (async (): Promise<void> => {
        let releaseSlot: (() => void) | null = null;
        try {
          releaseSlot = await acquireAgentProfileSyncSlot();
          await container.agentProfileSyncService.syncFromConnectedAgent({
            agentId: input.agentId,
            ...(input.userId !== null ? { userId: input.userId } : {}),
            dispatch: dispatchRpcCommandToAgent,
            timeoutMs: 10_000,
          });
          agentProfileSyncAttempts.delete(input.agentId);
          logger.info("agent_profile_sync_success", {
            agentId: input.agentId,
            userId: input.userId,
            attempt,
          });
        } catch (error: unknown) {
          const retryAfterMs =
            error instanceof AppError &&
            typeof error.details === "object" &&
            error.details !== null &&
            "retry_after_ms" in error.details &&
            typeof (error.details as { retry_after_ms?: unknown }).retry_after_ms === "number"
              ? Math.max(
                  0,
                  Math.floor((error.details as { retry_after_ms: number }).retry_after_ms),
                )
              : 0;
          const retryableProtocolWindow =
            error instanceof AppError &&
            error.code === "SERVICE_UNAVAILABLE" &&
            typeof error.message === "string" &&
            (error.message.includes("protocol negotiation is not ready") ||
              error.message.includes("Agent disconnected while waiting for response"));
          const shouldRetry = retryableProtocolWindow && attempt < 4;
          logger.warn("agent_profile_sync_failed", {
            agentId: input.agentId,
            userId: input.userId,
            attempt,
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof AppError
              ? { code: error.code, statusCode: error.statusCode }
              : {}),
            retryAfterMs,
            shouldRetry,
          });
          if (!shouldRetry) {
            agentProfileSyncAttempts.delete(input.agentId);
            return;
          }
          const nextDelay = retryAfterMs > 0 ? retryAfterMs : Math.min(8_000, 1_000 * attempt);
          scheduleAgentProfileSync(input, nextDelay);
        } finally {
          releaseSlot?.();
        }
      })();
    },
    Math.max(0, delayMs),
  );

  timer.unref?.();
  agentProfileSyncTimers.set(input.agentId, timer);
};

export let agentsNamespace: ReturnType<Server["of"]> | null = null;
let activeSocketServer: Server | null = null;
let conversationSweepTimer: NodeJS.Timeout | null = null;
const agentProfileSyncTimers = new Map<string, NodeJS.Timeout>();
const agentProfileSyncAttempts = new Map<string, number>();

const emitServerShutdownNotice = (io: Server, signal: string): void => {
  const payload = {
    message: `Server is shutting down (${signal}). Reconnect after a few seconds.`,
    code: "SERVER_SHUTDOWN",
  };

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
  const io = activeSocketServer;
  return {
    namespaces: {
      agents: io?.of(SOCKET_NAMESPACES.agents).sockets.size ?? 0,
      consumers: io?.of(SOCKET_NAMESPACES.consumers).sockets.size ?? 0,
    },
    relay: getRelayMetricsSnapshot(),
    relayRateLimit: getRelayRateLimitMetricsSnapshot(),
    socketRateLimitRedis: getSocketRateLimitRedisMetricsSnapshot(),
    agentsCommandSocketRateLimit: getAgentsCommandSocketRateLimitMetricsSnapshot(),
    clientSocketEventPublishSocketRateLimit: getClientSocketEventPublishSocketRateLimitMetricsSnapshot(),
    consumerRuntime: getSocketConsumerMetricsSnapshot(),
    agentRuntime: getSocketAgentMetricsSnapshot(),
  };
};

export const closeSocketServer = async (io: Server, signal = "shutdown"): Promise<void> => {
  emitServerShutdownNotice(io, signal);
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (conversationSweepTimer) {
    clearInterval(conversationSweepTimer);
    conversationSweepTimer = null;
  }

  resetRelayRateLimiterState();
  resetAgentsCommandSocketRateLimitState();
  resetClientSocketEventPublishSocketRateLimitState();
  resetAgentProfileSocketRateLimitState();
  resetConsumerCommandAbortRegistry();
  resetCustomSocketEventSubscriptions();
  resetCustomSocketEventSubscriptionRateLimitState();
  clearConsumerProfilePushState();
  resetSocketConsumerMetrics();
  resetSocketAgentMetrics();
  resetAgentRegisterRateLimitState();
  resetAgentProfileSyncConcurrency();
  resetSocketBridgeState();
  resetRestBridgeMetrics();
  conversationRegistry.clear();
  agentRegistry.clear();
  for (const timer of agentProfileSyncTimers.values()) {
    clearTimeout(timer);
  }
  agentProfileSyncTimers.clear();
  agentProfileSyncAttempts.clear();
  if (activeSocketServer === io) {
    activeSocketServer = null;
  }
  agentsNamespace = null;

  registerAgentProfileBroadcastHandler(undefined);
  registerAgentSocketControlHandler(undefined);
  registerConsumerSocketControlHandler(undefined);
  registerConsumerSocketEventHandler(undefined);

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
  agentsNamespace = agentsNsp;
  activeSocketServer = io;
  const consumersNsp = io.of(SOCKET_NAMESPACES.consumers);

  const defaultNsp = io.of("/");
  defaultNsp.on("connection", (socket: Socket) => {
    logger.warn("Client connected to default namespace (deprecated)", {
      socketId: socket.id,
      message: "Use /agents or /consumers instead",
    });
    socket.emit(socketEvents.appError, {
      message:
        "Default namespace (/) is deprecated. Connect to /agents (for agents) or /consumers (for consumers). See docs/migracao_plug_agente_namespaces.md",
      code: "NAMESPACE_DEPRECATED",
    });
    socket.disconnect(true);
  });

  agentsNsp.use(authenticateAgentSocket);
  consumersNsp.use(authenticateConsumerSocket);

  registerSocketBridgeServer(agentsNsp);
  registerConsumerBridgeServer(consumersNsp);

  if (conversationSweepTimer) {
    clearInterval(conversationSweepTimer);
  }
  conversationSweepTimer = setInterval(() => {
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
  conversationSweepTimer.unref?.();

  agentsNsp.on("connection", async (socket: HubSocket) => {
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
      socket.emit(socketEvents.appError, {
        code: "ROOM_JOIN_FAILED",
        message: "Failed to join agent identity room",
      });
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

      const payloadAgentId = isRecord(decoded.value.data) ? decoded.value.data.agent_id : undefined;
      const currentAgentId = resolveCanonicalRegisteredAgentId(
        socket,
        socketEvents.agentReady,
        payloadAgentId,
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
    });
  });

  consumersNsp.on("connection", async (socket: HubSocket) => {
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
      socket.emit(socketEvents.appError, {
        code: "CONSUMER_SOCKET_INITIALIZATION_FAILED",
        message: "Consumer socket initialization failed",
      });
      noteConsumerSocketDisconnected(socket.data.user?.principal_type ?? null);
      socket.disconnect(true);
      return;
    }

    emitConnectionReady(socket, {
      id: socket.id,
      message: "Consumer socket connected successfully",
      user: socket.data.user ?? null,
    });

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

        await handleRelayConversationStart(socket, rawPayload, agentsNsp);
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
      for (const conversation of endedConversations) {
        cleanupConversationStreamSubscriptions(conversation.conversationId);
      }
      if (abortedCommands > 0) {
        noteConsumerPendingCommandsAborted(abortedCommands);
        logger.info("consumer_socket_pending_commands_aborted", {
          socketId: socket.id,
          abortedCommands,
        });
      }
    });
  });

  if (env.socketClientAgentProfilePushEnabled) {
    registerAgentProfileBroadcastHandler(async (event) => {
      scheduleAgentProfilePush(consumersNsp, event);
    });
  } else {
    // Operational kill-switch: keeps the consumer namespace healthy while the
    // client-agent profile push is disabled. `agent_profile_broadcast_sink`
    // becomes a no-op until the next boot with the env enabled.
    registerAgentProfileBroadcastHandler(undefined);
  }

  registerAgentSocketControlHandler({
    disconnectPrincipal: async (event) => {
      await disconnectAgentSocketsInRoom(
        agentsNsp,
        `agent:principal:${event.userId}`,
        {
          code: "ACCOUNT_BLOCKED",
          message: "Account is blocked",
        },
        {
          userId: event.userId,
          reason: event.reason,
        },
      );
    },
  });

  registerConsumerSocketControlHandler({
    disconnectPrincipal: async (event) => {
      const room = `consumer:principal:${event.principalType}:${event.principalId}`;
      await disconnectConsumerSocketsInRoom(
        consumersNsp,
        room,
        {
          code: "ACCOUNT_BLOCKED",
          message:
            event.principalType === "client" ? "Client account is blocked" : "Account is blocked",
        },
        {
          principalType: event.principalType,
          principalId: event.principalId,
          reason: event.reason,
        },
      );
    },
    revokeClientAccess: async (event) => {
      clientProfileRecipientsCacheByAgentId.delete(event.agentId);
      await disconnectConsumerSocketsInRoom(
        consumersNsp,
        buildConsumerClientAgentRoom({
          clientId: event.clientId,
          agentId: event.agentId,
        }),
        {
          code: "AGENT_ACCESS_REVOKED",
          message: `Client access to agent ${event.agentId} was revoked`,
        },
        {
          clientId: event.clientId,
          agentId: event.agentId,
          reason: event.reason,
        },
      );
    },
  });

  registerConsumerSocketEventHandler({
    publish: async (event) => {
      const room = buildCustomSocketEventRoom(event.eventName);
      const recipients = (await consumersNsp.in(room).fetchSockets()).length;
      if (recipients === 0) {
        return { recipients };
      }
      if (env.restSocketEventMaxRecipients > 0 && recipients > env.restSocketEventMaxRecipients) {
        throw new AppError("socket event recipient fan-out limit exceeded", {
          statusCode: 503,
          code: "SERVICE_UNAVAILABLE",
          details: { retry_after_ms: env.restSocketEventRateLimitWindowMs },
        });
      }
      const frame = await encodePayloadFrameBridge(
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
      consumersNsp.to(room).emit(event.eventName, frame);
      return { recipients };
    },
  });

  return io;
};
