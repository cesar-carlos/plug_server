/**
 * Agent namespace connection and event handlers.
 *
 * Extracted from `src/socket.ts` to keep the orchestrator thin. The
 * `agent:register` handler lives in `handlers/agent_register.handler.ts`
 * (extracted because it is the largest and most distinct flow); the
 * remaining protocol handlers (heartbeat, ready, profile.update) and the
 * RPC listeners stay here because they share the profile-sync scheduler
 * and the canonical-registration helpers.
 */

import type { Namespace } from "socket.io";

import {
  syncAgentHubPresenceOnDisconnect,
  syncAgentHubPresenceOnTouch,
} from "../../../application/services/agent_hub_presence_sync";
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
import { AppError } from "../../../shared/errors/app_error";
import { badRequest, forbidden, tooManyRequests } from "../../../shared/errors/http_errors";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  noteAgentReadyInvalidPartialPayload,
  noteAgentReadyLegacyPayload,
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
import { resolveRequiresExplicitProtocolReadyAck } from "./agent_register_payload";
import { agentSelfProfileSocketSchema } from "../../../shared/validators/agent_self_profile_socket";
import { toAgentCatalogDto } from "../../http/serializers/agent_catalog.serializer";
import {
  type AgentHubNamespace,
  type AgentHubSocket,
  emitAppError,
  getUserId,
  isRecord,
  withOptionalRequestId,
} from "./handlers/_shared";
import { handleAgentRegister } from "./handlers/agent_register.handler";
import { handleAgentAutoUpdateDiagnosticsRpcRequest } from "./handlers/agent_auto_update_diagnostics.handler";

export type { AgentHubSocket } from "./handlers/_shared";

const buildAgentPrincipalRoom = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.sub === "string" && user.sub.trim() !== "" ? `agent:principal:${user.sub}` : null;

const joinAgentIdentityRooms = async (socket: AgentHubSocket): Promise<void> => {
  const room = buildAgentPrincipalRoom(socket.data.user);
  if (room) {
    await socket.join(room);
  }
};

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
    void syncAgentHubPresenceOnDisconnect({
      agentId: removedAgent.agentId,
      socketId: socket.id,
    });
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

// ─── agent:profile.update handler ─────────────────────────────────────────────

/**
 * Handles a self-service `agent:profile.update` from an authenticated agent
 * socket: decodes the frame, enforces identity (socket agent == token agent ==
 * payload agent) and the socket rate limit, validates the payload, then
 * persists the profile patch (with optimistic version / idempotency) and emits
 * the updated snapshot back to the agent. All failure paths emit a structured
 * `agent:profile.updated` error frame.
 */
const handleAgentProfileUpdate = async (
  socket: AgentHubSocket,
  rawPayload: unknown,
): Promise<void> => {
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
      error: badRequest(parsed.error.issues[0]?.message ?? "Invalid agent:profile.update payload"),
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
};

// ─── agent:heartbeat / agent:ready handlers ───────────────────────────────────

/**
 * Handles `agent:heartbeat`: validates the canonical registered agent, marks
 * the protocol ready / touches liveness, and emits `hub:heartbeat_ack`
 * (mirroring the `trace_id` so the agent can correlate without a synced clock).
 */
const handleAgentHeartbeat = async (socket: AgentHubSocket, rawPayload: unknown): Promise<void> => {
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

  const readiness = agentRegistry.getProtocolReadiness(currentAgentId);
  const waitingExplicitAck =
    !readiness.ready && agentRegistry.getProtocolReadyMode(currentAgentId) === "explicit_ack";

  agentRegistry.touch(currentAgentId, {
    // Under explicit protocolReadyAck, only agent:ready (not heartbeat) should clear the wait.
    markProtocolReady: !waitingExplicitAck,
    socketId: socket.id,
  });
  void syncAgentHubPresenceOnTouch(currentAgentId);

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
};

/**
 * Handles `agent:ready`: parses the (possibly legacy) ready payload, validates
 * the canonical agent, marks protocol ready, and—when the agent opted into the
 * explicit `protocol_ready_ack` handshake—schedules the deferred profile sync.
 */
const handleAgentReady = async (socket: AgentHubSocket, rawPayload: unknown): Promise<void> => {
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
  void syncAgentHubPresenceOnTouch(currentAgentId);

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
};

// ─── agent:register handler ───────────────────────────────────────────────────
//
// The `agent:register` handler now lives in
// [./handlers/agent_register.handler.ts](./handlers/agent_register.handler.ts).
// It is invoked from `registerAgentSocketConnectionHandlers` below with the
// namespace and `scheduleAgentProfileSync` passed in as an explicit context.

// ─── Connection handler ───────────────────────────────────────────────────────

export type RegisterAgentSocketHandlersInput = {
  readonly agentsNsp: AgentHubNamespace;
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

    socket.on(socketEvents.agentRegister, (rawPayload: unknown) => {
      void handleAgentRegister(socket, rawPayload, {
        agentsNsp,
        scheduleAgentProfileSync,
      });
    });

    socket.on(socketEvents.agentHeartbeat, (rawPayload: unknown) => {
      void handleAgentHeartbeat(socket, rawPayload);
    });

    socket.on(socketEvents.agentReady, (rawPayload: unknown) => {
      void handleAgentReady(socket, rawPayload);
    });

    socket.on(socketEvents.agentProfileUpdate, (rawPayload: unknown) => {
      void handleAgentProfileUpdate(socket, rawPayload);
    });

    socket.on(socketEvents.rpcRequest, (rawPayload: unknown) => {
      void handleAgentAutoUpdateDiagnosticsRpcRequest(socket, rawPayload);
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
