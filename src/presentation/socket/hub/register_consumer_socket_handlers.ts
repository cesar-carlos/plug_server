import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Server, Socket } from "socket.io";

import { handleAgentsCommand } from "../consumers/agents_command.handler";
import { handleAgentsStreamPull } from "../consumers/agents_stream_pull.handler";
import { abortPendingConsumerCommands } from "../consumers/consumer_command_abort_registry";
import { handleCustomSocketEventPublish } from "../consumers/custom_socket_event_publish.handler";
import {
  handleCustomSocketEventSubscribe,
  handleCustomSocketEventUnsubscribe,
} from "../consumers/custom_socket_event_subscription.handler";
import { handleRelayConversationEnd } from "../consumers/relay_conversation_end.handler";
import {
  extractRelayConversationStartRequestId,
  handleRelayConversationStart,
  parseRelayConversationStartEnvelope,
} from "../consumers/relay_conversation_start.handler";
import {
  handleRelayRpcRequest,
  parseRelayRpcRequestEnvelope,
} from "../consumers/relay_rpc_request.handler";
import {
  handleRelayRpcStreamPull,
  parseRelayRpcStreamPullEnvelope,
} from "../consumers/relay_rpc_stream_pull.handler";
import { observeRelayOverloadCheck } from "./relay/bridge_relay_health_metrics";
import { emitConnectionReady } from "./handshake/connection_ready_handshake";
import { conversationRegistry } from "./registries/conversation_registry";
import {
  backfillConsumerApprovedAgentRooms,
  reconcileConsumerClientAgentRoomsForSocket,
  type ConsumerClientAgentRoomBootstrapState,
} from "./scheduling/consumer_client_agent_room_reconcile";
import { consumerRegistry } from "./registries/consumer_registry";
import { touchConsumerRegistryOnInboundEvent } from "./scheduling/consumer_idle_touch_events";
import {
  buildConsumerClientRoom as buildClientRoomName,
  buildConsumerPrincipalRoom as buildPrincipalRoomName,
} from "./consumer_identity_rooms";
import {
  allowRelayConversationStartAsync,
  allowRelayRpcRequestAsync,
  clearRelayRateLimitStateByConsumerSocket,
} from "./rate_limits/consumer_relay_rate_limiter";
import { clearAgentsCommandSocketRateLimitStateForSocketId } from "./rate_limits/agents_command_socket_rate_limiter";
import { clearCustomSocketEventSubscriptionRateLimitState } from "./rate_limits/custom_socket_event_subscription_limiter";
import { removeCustomSocketEventSubscriptionsBySocketId } from "./custom_events/custom_socket_event_subscription_registry";
import {
  buildRelayConversationEndedPayload,
  cleanupConsumerStreamSubscriptions,
  finalizeConversationsClosedByConsumerDisconnect,
  registerConsumerBridgeSocket,
  unregisterConsumerBridgeSocket,
} from "./relay/rpc_bridge";
import {
  getRelayOutboundQueueOverloadState,
  noteRelayOutboundQueueOverloadRejected,
} from "./relay/relay_outbound_queue";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  noteConsumerPendingCommandsAborted,
  noteConsumerSocketConnected,
  noteConsumerSocketDisconnected,
  noteCustomSocketEventSubscriptionsRemoved,
} from "../../../shared/metrics/socket_consumer.metrics";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { logger } from "../../../shared/utils/logger";
import { clearAgentProfileSocketRateLimitStateForSocketId } from "./rate_limits/agent_profile_socket_rate_limiter";
import { clearInflightValidationForSocket } from "../auth/ensure_socket_active_account";

type SocketData = {
  user?: JwtAccessPayload;
};

export type ConsumerHubSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

type HubNamespace = ReturnType<Server["of"]>;

const buildConsumerOverloadError = (
  retryAfterMs: number,
  reason: string,
): { code: string; message: string; statusCode: number; retryAfterMs: number } => ({
  code: "SERVICE_UNAVAILABLE",
  message: `Consumer namespace temporarily overloaded (${reason})`,
  statusCode: 503,
  retryAfterMs,
});

const extractRelayEnvelopeConversationId = (rawPayload: unknown): string | undefined => {
  if (typeof rawPayload !== "object" || rawPayload === null) {
    return undefined;
  }
  const id = (rawPayload as Record<string, unknown>).conversationId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
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

const joinConsumerIdentityRooms = async (socket: ConsumerHubSocket): Promise<void> => {
  const user = socket.data.user;
  const rooms = [buildConsumerPrincipalRoom(user), buildConsumerClientRoom(user)].filter(
    (room): room is string => room !== null,
  );
  if (rooms.length === 0) {
    return;
  }
  await socket.join(rooms);
};

export const runConsumerSocketDisconnectCleanup = (
  socket: ConsumerHubSocket,
  agentsNsp: HubNamespace,
  getUserId: (socket: ConsumerHubSocket) => string | null,
): void => {
  unregisterConsumerBridgeSocket(socket.id);
  clearInflightValidationForSocket(socket.id);
  consumerRegistry.removeBySocketId(socket.id);
  const abortedCommands = abortPendingConsumerCommands(socket.id);
  const removedCustomEventSubscriptions = removeCustomSocketEventSubscriptionsBySocketId(socket.id);
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
  logger.info("Consumer socket disconnected", {
    socketId: socket.id,
    userId: getUserId(socket),
    abortedCommands,
    endedConversations: endedConversations.length,
  });
  if (abortedCommands > 0) {
    noteConsumerPendingCommandsAborted(abortedCommands);
    logger.info("consumer_socket_pending_commands_aborted", {
      socketId: socket.id,
      abortedCommands,
    });
  }
};

export type RegisterConsumerSocketHandlersInput = {
  readonly state: ConsumerClientAgentRoomBootstrapState;
  readonly consumersNsp: HubNamespace;
  readonly agentsNsp: HubNamespace;
  readonly getUserId: (socket: ConsumerHubSocket) => string | null;
};

export const registerConsumerSocketConnectionHandlers = ({
  state,
  consumersNsp,
  agentsNsp,
  getUserId,
}: RegisterConsumerSocketHandlersInput): void => {
  consumersNsp.on("connection", async (socket: ConsumerHubSocket) => {
    registerConsumerBridgeSocket(consumersNsp, socket.id);
    logger.info("Consumer socket connected", {
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
    consumerRegistry.registerSession({
      socketId: socket.id,
      userId: getUserId(socket),
      principalType:
        socket.data.user?.principal_type === "client" || socket.data.user?.principal_type === "user"
          ? socket.data.user.principal_type
          : null,
    });
    socket.onAny((eventName) => {
      touchConsumerRegistryOnInboundEvent(socket.id, eventName);
    });
    void backfillConsumerApprovedAgentRooms(state, socket, {
      getUserId,
      reconcileRoomsForSocket: reconcileConsumerClientAgentRoomsForSocket,
    });

    socket.on(socketEvents.agentsCommand, (rawPayload: unknown) => {
      handleAgentsCommand(socket, rawPayload);
    });

    socket.on(socketEvents.agentsStreamPull, (rawPayload: unknown) => {
      handleAgentsStreamPull(socket, rawPayload);
    });

    socket.on(socketEvents.relayConversationStart, (rawPayload: unknown) => {
      void (async (): Promise<void> => {
        const requestId = extractRelayConversationStartRequestId(rawPayload);
        const tOverload = performance.now();
        const overload = getRelayOutboundQueueOverloadState();
        observeRelayOverloadCheck(performance.now() - tOverload);
        if (overload.overloaded) {
          noteRelayOutboundQueueOverloadRejected();
          socket.emit(socketEvents.relayConversationStarted, {
            success: false,
            ...(requestId !== undefined ? { requestId } : {}),
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
            ...(requestId !== undefined ? { requestId } : {}),
            error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
          });
          return;
        }

        const userSub = socket.data.user?.sub;
        if (!(await allowRelayConversationStartAsync(userSub, socket.id))) {
          socket.emit(socketEvents.relayConversationStarted, {
            success: false,
            ...(requestId !== undefined ? { requestId } : {}),
            error: {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded for relay:conversation.start",
              statusCode: 429,
            },
          });
          return;
        }

        await handleRelayConversationStart(socket, envelope.data);
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
          const conversationId = extractRelayEnvelopeConversationId(rawPayload);
          socket.emit(socketEvents.relayRpcAccepted, {
            success: false,
            ...(conversationId !== undefined ? { conversationId } : {}),
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
          const conversationId = extractRelayEnvelopeConversationId(rawPayload);
          socket.emit(socketEvents.relayRpcAccepted, {
            success: false,
            ...(conversationId !== undefined ? { conversationId } : {}),
            error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
          });
          return;
        }

        const userSub = socket.data.user?.sub;
        if (!(await allowRelayRpcRequestAsync(userSub, socket.id))) {
          socket.emit(socketEvents.relayRpcAccepted, {
            success: false,
            conversationId: envelope.data.conversationId,
            error: {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded for relay:rpc.request",
              statusCode: 429,
            },
          });
          return;
        }

        handleRelayRpcRequest(socket, envelope.data);
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
        const conversationId = extractRelayEnvelopeConversationId(rawPayload);
        socket.emit(socketEvents.relayRpcStreamPullResponse, {
          success: false,
          ...(conversationId !== undefined ? { conversationId } : {}),
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
        const conversationId = extractRelayEnvelopeConversationId(rawPayload);
        socket.emit(socketEvents.relayRpcStreamPullResponse, {
          success: false,
          ...(conversationId !== undefined ? { conversationId } : {}),
          error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
        });
        return;
      }

      handleRelayRpcStreamPull(socket, envelope.data);
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
      runConsumerSocketDisconnectCleanup(socket, agentsNsp, getUserId);
    });
  });
};
