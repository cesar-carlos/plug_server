import type { Server as HttpServer } from "node:http";

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import { Server, type Socket } from "socket.io";

import {
  authenticateAgentSocket,
  authenticateConsumerSocket,
} from "./presentation/socket/auth/socket_namespace_auth.middleware";
import { agentRegistry } from "./presentation/socket/hub/agent_registry";
import { handleAgentsCommand } from "./presentation/socket/consumers/agents_command.handler";
import { handleAgentsStreamPull } from "./presentation/socket/consumers/agents_stream_pull.handler";
import {
  cleanupAgentStreamSubscriptions,
  cleanupConversationStreamSubscriptions,
  cleanupConsumerStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
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
import { conversationRegistry } from "./presentation/socket/hub/conversation_registry";
import {
  allowRelayConversationStart,
  allowRelayRpcRequest,
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
import { handleRelayConversationStart } from "./presentation/socket/consumers/relay_conversation_start.handler";
import { handleRelayConversationEnd } from "./presentation/socket/consumers/relay_conversation_end.handler";
import { handleRelayRpcRequest } from "./presentation/socket/consumers/relay_rpc_request.handler";
import { handleRelayRpcStreamPull } from "./presentation/socket/consumers/relay_rpc_stream_pull.handler";
import { resetRestBridgeMetrics } from "./application/services/rest_bridge_metrics.service";
import { env } from "./shared/config/env";
import { socketEvents, SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import type { JwtAccessPayload } from "./shared/utils/jwt";
import { logger } from "./shared/utils/logger";
import { decodePayloadFrame, encodePayloadFrame } from "./shared/utils/payload_frame";

type SocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: Record<string, unknown>;
};

type HubSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const serverCapabilities = {
  protocols: ["jsonrpc-v2"],
  encodings: ["json"],
  compressions: ["gzip", "none"],
  extensions: {
    batchSupport: true,
    binaryPayload: true,
    compressionThreshold: 1024,
    /** Aligned with plug_agente OutboundCompressionMode.auto: gzip only when smaller than raw UTF-8. */
    outboundCompressionMode: "auto",
    maxInflationRatio: 20,
    signatureRequired: false,
    signatureScope: "transport-frame",
    /** Aligned with plug_agente capabilities example (`hmac-sha256` transport-frame signing). */
    signatureAlgorithms: ["hmac-sha256"],
    streamingResults: true,
    plugProfile: "plug-jsonrpc-profile/2.5",
    orderedBatchResponses: true,
    notificationNullIdCompatibility: true,
    paginationModes: ["page-offset", "cursor-keyset"],
    traceContext: ["w3c-trace-context", "legacy-trace-id"],
    errorFormat: "structured-error-data",
    transportFrame: "payload-frame/1.0",
  },
  limits: {
    max_payload_bytes: 10 * 1024 * 1024,
    max_compressed_payload_bytes: 10 * 1024 * 1024,
    max_decoded_payload_bytes: 10 * 1024 * 1024,
    max_rows: 50000,
    max_batch_size: 32,
    max_concurrent_streams: 1,
    streaming_chunk_size: 500,
    streaming_row_threshold: 500,
  },
} as const;

const emitAppError = (socket: HubSocket, message: string): void => {
  socket.emit(socketEvents.appError, {
    message,
    code: "SOCKET_PROTOCOL_ERROR",
  });
};

const getUserId = (socket: HubSocket): string | null => {
  return typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const withOptionalRequestId = (
  requestId: string | null | undefined,
): { readonly requestId?: string } => {
  return requestId ? { requestId } : {};
};

export let agentsNamespace: ReturnType<Server["of"]> | null = null;
let activeSocketServer: Server | null = null;
let conversationSweepTimer: NodeJS.Timeout | null = null;

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
  readonly agentsCommandSocketRateLimit: ReturnType<typeof getAgentsCommandSocketRateLimitMetricsSnapshot>;
} => {
  const io = activeSocketServer;
  return {
    namespaces: {
      agents: io?.of(SOCKET_NAMESPACES.agents).sockets.size ?? 0,
      consumers: io?.of(SOCKET_NAMESPACES.consumers).sockets.size ?? 0,
    },
    relay: getRelayMetricsSnapshot(),
    relayRateLimit: getRelayRateLimitMetricsSnapshot(),
    agentsCommandSocketRateLimit: getAgentsCommandSocketRateLimitMetricsSnapshot(),
  };
};

export const closeSocketServer = async (
  io: Server,
  signal = "shutdown",
): Promise<void> => {
  emitServerShutdownNotice(io, signal);
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (conversationSweepTimer) {
    clearInterval(conversationSweepTimer);
    conversationSweepTimer = null;
  }

  resetRelayRateLimiterState();
  resetAgentsCommandSocketRateLimitState();
  resetSocketBridgeState();
  resetRestBridgeMetrics();
  conversationRegistry.clear();
  agentRegistry.clear();
  if (activeSocketServer === io) {
    activeSocketServer = null;
  }
  agentsNamespace = null;

  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
};

export const createSocketServer = (httpServer: HttpServer): Server => {
  const websocketOnly =
    env.socketIoTransports.length === 1 && env.socketIoTransports[0] === "websocket";

  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin,
    },
    maxHttpBufferSize: env.socketIoMaxHttpBufferBytes,
    perMessageDeflate: env.socketIoPerMessageDeflate,
    transports: env.socketIoTransports,
    serveClient: env.socketIoServeClient,
    httpCompression: env.socketIoHttpCompression,
    ...(websocketOnly ? { allowUpgrades: false } : {}),
    ...(env.socketIoPingIntervalMs !== undefined ? { pingInterval: env.socketIoPingIntervalMs } : {}),
    ...(env.socketIoPingTimeoutMs !== undefined ? { pingTimeout: env.socketIoPingTimeoutMs } : {}),
  });

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
    const expiredConversations = conversationRegistry.removeExpired(
      env.socketRelayConversationIdleTimeoutMs,
    );
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

  agentsNsp.on("connection", (socket: HubSocket) => {
    logger.info("Socket client connected", {
      socketId: socket.id,
      userId: getUserId(socket),
    });

    socket.emit(socketEvents.connectionReady, {
      id: socket.id,
      message: "Socket connected successfully",
      user: socket.data.user ?? null,
    });

    socket.on(socketEvents.agentRegister, (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        emitAppError(socket, decoded.error.message);
        return;
      }

      if (!isRecord(decoded.value.data)) {
        emitAppError(socket, "agent:register payload must be an object");
        return;
      }

      const { agentId, capabilities } = decoded.value.data;
      if (typeof agentId !== "string" || agentId.trim() === "" || !isRecord(capabilities)) {
        emitAppError(socket, "agent:register payload is missing required fields");
        return;
      }

      const tokenAgentId = socket.data.user?.agent_id;
      if (
        typeof tokenAgentId === "string" &&
        tokenAgentId.trim() !== "" &&
        tokenAgentId !== agentId
      ) {
        emitAppError(socket, "agent:register agentId does not match token claim");
        return;
      }

      socket.data.agentId = agentId;
      socket.data.capabilities = capabilities;
      const registration = agentRegistry.upsert({
        agentId,
        socketId: socket.id,
        userId: getUserId(socket),
        capabilities,
      });
      if (!registration.ok) {
        emitAppError(socket, "agent:register denied because this agentId belongs to another user");
        return;
      }

      logger.info("Agent registered on hub", {
        socketId: socket.id,
        agentId,
        userId: getUserId(socket),
      });

      socket.emit(
        socketEvents.agentCapabilities,
        encodePayloadFrame(
          {
            capabilities: serverCapabilities,
          },
          { ...withOptionalRequestId(decoded.value.frame.requestId), omitTraceId: true },
        ),
      );
    });

    socket.on(socketEvents.agentHeartbeat, (rawPayload: unknown) => {
      const decoded = decodePayloadFrame(rawPayload);
      if (!decoded.ok) {
        emitAppError(socket, decoded.error.message);
        return;
      }

      const currentAgentId =
        socket.data.agentId ??
        (isRecord(decoded.value.data) && typeof decoded.value.data.agent_id === "string"
          ? decoded.value.data.agent_id
          : undefined);

      if (!currentAgentId) {
        emitAppError(socket, "agent:heartbeat received before agent registration");
        return;
      }

      agentRegistry.touch(currentAgentId);

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
      cleanupAgentStreamSubscriptions(socket.id);
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
        logger.info("Agent disconnected from hub", {
          socketId: socket.id,
          agentId: removedAgent.agentId,
          userId: removedAgent.userId,
          cleanedPendingRequests,
        });
      }
    });
  });

  consumersNsp.on("connection", (socket: HubSocket) => {
    logger.info("Consumer socket connected", {
      socketId: socket.id,
      userId: getUserId(socket),
    });

    socket.emit(socketEvents.connectionReady, {
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
      if (!allowRelayConversationStart(socket.id)) {
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

      handleRelayConversationStart(socket, rawPayload, agentsNsp);
    });

    socket.on(socketEvents.relayConversationEnd, (rawPayload: unknown) => {
      handleRelayConversationEnd(socket, rawPayload);
    });

    socket.on(socketEvents.relayRpcRequest, (rawPayload: unknown) => {
      if (!allowRelayRpcRequest(socket.id)) {
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
    });

    socket.on(socketEvents.relayRpcStreamPull, (rawPayload: unknown) => {
      handleRelayRpcStreamPull(socket, rawPayload);
    });

    socket.on("disconnect", () => {
      cleanupConsumerStreamSubscriptions(socket.id);
      clearRelayRateLimitStateByConsumerSocket(socket.id);
      clearAgentsCommandSocketRateLimitStateForSocketId(socket.id);
      const endedConversations = conversationRegistry.removeByConsumerSocketId(socket.id);
      for (const conversation of endedConversations) {
        cleanupConversationStreamSubscriptions(conversation.conversationId);
      }
    });
  });

  return io;
};
