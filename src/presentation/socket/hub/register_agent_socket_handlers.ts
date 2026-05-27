/**
 * Agent namespace connection and event handlers.
 *
 * Extracted from `src/socket.ts` to keep the orchestrator thin. All agent-side
 * protocol logic lives here: register, heartbeat, ready, profile update, and the
 * five RPC inbound events (response, ack, batch-ack, chunk, complete).
 */

import type { DefaultEventsMap } from "@socket.io/component-emitter";
import type { Namespace, Socket } from "socket.io";

import { AgentProfileSyncScheduler } from "./scheduling/agent_profile_sync_scheduler";
import { agentRegistry } from "./registries/agent_registry";
import {
  acquireAgentProfileSyncSlot,
  resetAgentProfileSyncConcurrency,
} from "./scheduling/agent_profile_sync_concurrency";
import {
  allowAgentProfileSocketUpdate,
  clearAgentProfileSocketRateLimitStateForAgentId,
  clearAgentProfileSocketRateLimitStateForSocketId,
} from "./rate_limits/agent_profile_socket_rate_limiter";
import {
  AGENT_REGISTER_RATE_LIMIT_MESSAGE,
  AGENT_REGISTER_SESSION_ACTIVE_MESSAGE,
  AGENT_SESSION_SUPERSEDED_MESSAGE,
  emitAgentRegisterError,
} from "./handshake/agent_register_error";
import { tryConsumeAgentRegisterRateLimitAsync } from "./rate_limits/agent_register_rate_limit";
import { parseAgentReadyPayload } from "./handshake/agent_ready_payload";
import { emitConnectionReady } from "./handshake/connection_ready_handshake";
import { conversationRegistry } from "./registries/conversation_registry";
import {
  cleanupAgentInboundSocketState,
  cleanupAgentStreamSubscriptions,
  cleanupConversationStreamSubscriptions,
  cleanupPendingRequestsForAgentSocket,
  buildRelayConversationEndedPayload,
} from "./relay/rpc_bridge";
import {
  dispatchRpcCommandToAgent,
  handleAgentRpcResponse,
  handleAgentRpcAck,
  handleAgentBatchAck,
  handleAgentRpcChunk,
  handleAgentRpcComplete,
  registerAgentBridgeSocket,
  unregisterAgentBridgeSocket,
} from "./relay/rpc_bridge";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";
import { AppError } from "../../../shared/errors/app_error";
import { badRequest, forbidden, tooManyRequests } from "../../../shared/errors/http_errors";
import { buildHubServerCapabilities } from "../../../shared/constants/agent_transport_contract";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  noteAgentCapabilityProfile,
  noteAgentReadyInvalidPartialPayload,
  noteAgentReadyLegacyPayload,
  noteAgentRegisterRateLimited,
  noteAgentSessionRejectedActive,
  noteAgentSessionTakeoverDisconnect,
} from "../../../shared/metrics/socket_agent.metrics";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { logger } from "../../../shared/utils/logger";
import {
  decodePayloadFrameAsync,
  encodePayloadFrameBridge,
  encodePayloadFrameHotPath,
} from "../../../shared/utils/payload_frame";
import { agentProfileReliabilityMetrics } from "../../../application/services/agent_profile_reliability_metrics.service";
import type { AgentRegisterProfileSnapshot } from "../../../application/services/agent_profile_sync.service";
import {
  agentRegisterPayloadSchema,
  type AgentRegisterPayload,
} from "../../../shared/validators/agent_register";
import { agentSelfProfileSocketSchema } from "../../../shared/validators/agent_self_profile_socket";
import { toAgentCatalogDto } from "../../http/serializers/agent_catalog.serializer";

type AgentCapabilities = AgentRegisterPayload["capabilities"];

type SocketData = {
  user?: JwtAccessPayload;
  agentId?: string;
  capabilities?: AgentCapabilities;
  agentRegisterProfileSnapshot?: AgentRegisterProfileSnapshot;
};

export type AgentHubSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
type HubNamespace = Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const emitAppError = (socket: AgentHubSocket, message: string): void => {
  socket.emit(
    socketEvents.appError,
    buildLegacySocketAppErrorPayload("SOCKET_PROTOCOL_ERROR", message),
  );
};

const getUserId = (socket: AgentHubSocket): string | null =>
  typeof socket.data.user?.sub === "string" ? socket.data.user.sub : null;

const buildAgentPrincipalRoom = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.sub === "string" && user.sub.trim() !== "" ? `agent:principal:${user.sub}` : null;

const joinAgentIdentityRooms = async (socket: AgentHubSocket): Promise<void> => {
  const room = buildAgentPrincipalRoom(socket.data.user);
  if (room) {
    await socket.join(room);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
): { readonly requestId?: string } => (requestId ? { requestId } : {});

const emitAgentProfileUpdated = async (
  socket: AgentHubSocket,
  requestId: string | null | undefined,
  payload: Record<string, unknown>,
): Promise<void> => {
  const frame = await encodePayloadFrameBridge(payload, {
    ...withOptionalRequestId(requestId),
    omitTraceId: true,
  });
  socket.emit(socketEvents.agentProfileUpdated, frame);
};

const emitAgentProfileUpdateError = (
  socket: AgentHubSocket,
  input: {
    readonly requestId: string | null | undefined;
    readonly agentId?: string;
    readonly error: AppError;
  },
): Promise<void> =>
  emitAgentProfileUpdated(socket, input.requestId, {
    success: false,
    ...(input.agentId !== undefined ? { agent_id: input.agentId } : {}),
    error: {
      code: input.error.code,
      message: input.error.message,
      statusCode: input.error.statusCode,
    },
  });

const resolveCanonicalRegisteredAgentId = (
  socket: AgentHubSocket,
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

// ─── Profile sync scheduler ───────────────────────────────────────────────────

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

export const clearAgentProfileSyncState = (agentId: string): void => {
  agentProfileSyncScheduler.clear(agentId);
};

export const resetAgentProfileSyncScheduler = (): void => {
  agentProfileSyncScheduler.reset();
  resetAgentProfileSyncConcurrency();
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

// ─── Disconnect cleanup ───────────────────────────────────────────────────────

export const runAgentSocketDisconnectCleanup = (
  socket: AgentHubSocket,
  consumersNsp: Namespace,
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
    consumerSocket?.emit(
      socketEvents.relayConversationEnded,
      buildRelayConversationEndedPayload(conversation.conversationId, "agent_disconnected"),
    );
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

// ─── Connection handler ───────────────────────────────────────────────────────

export type RegisterAgentSocketHandlersInput = {
  readonly agentsNsp: HubNamespace;
  readonly consumersNsp: Namespace;
};

export const registerAgentSocketConnectionHandlers = ({
  agentsNsp,
  consumersNsp,
}: RegisterAgentSocketHandlersInput): void => {
  agentsNsp.on("connection", async (socket: AgentHubSocket) => {
    registerAgentBridgeSocket(agentsNsp as Namespace, socket.id);
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

      const payloadData = isRecord(decoded.value.data) ? decoded.value.data : {};
      const payloadAgentId = payloadData.agent_id;
      // Mirror trace_id back so the agent can correlate emission with ack
      // without requiring a synchronised clock (spec: socket_communication_standard.md § heartbeat).
      const payloadTraceId =
        typeof payloadData.trace_id === "string" && payloadData.trace_id.trim() !== ""
          ? payloadData.trace_id
          : undefined;

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
            ...(payloadTraceId !== undefined ? { trace_id: payloadTraceId } : {}),
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
        await emitAgentProfileUpdateError(socket, {
          requestId: undefined,
          error: badRequest(decoded.error.message),
        });
        return;
      }

      const requestId = decoded.value.frame.requestId;

      if (!isRecord(decoded.value.data)) {
        await emitAgentProfileUpdateError(socket, {
          requestId,
          error: badRequest("agent:profile.update payload must be an object"),
        });
        return;
      }

      const authenticatedAgentId = socket.data.agentId;
      const tokenAgentId = socket.data.user?.agent_id;
      const userId = getUserId(socket);

      if (!authenticatedAgentId) {
        await emitAgentProfileUpdateError(socket, {
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
        await emitAgentProfileUpdateError(socket, {
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
        await emitAgentProfileUpdateError(socket, {
          requestId,
          agentId: authenticatedAgentId,
          error: tooManyRequests("Rate limit exceeded for agent:profile.update"),
        });
        return;
      }

      const parsed = agentSelfProfileSocketSchema.safeParse(decoded.value.data);
      if (!parsed.success) {
        await emitAgentProfileUpdateError(socket, {
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
        await emitAgentProfileUpdateError(socket, {
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
        await emitAgentProfileUpdated(socket, requestId, {
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
        await emitAgentProfileUpdateError(socket, {
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
};
