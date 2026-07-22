import { agentRegistry } from "../registries/agent_registry";
import {
  AGENT_REGISTER_RATE_LIMIT_MESSAGE,
  AGENT_REGISTER_SESSION_ACTIVE_MESSAGE,
  AGENT_SESSION_SUPERSEDED_MESSAGE,
  emitAgentRegisterError,
} from "../handshake/agent_register_error";
import {
  tryConsumeAgentRegisterRateLimitAsync,
  refundAgentRegisterRateLimitAsync,
} from "../rate_limits/agent_register_rate_limit";
import {
  resolveAgentRegisterProfileSnapshot,
  resolveRequiresExplicitProtocolReadyAck,
} from "../agent_register_payload";
import { container } from "../../../../shared/di/container";
import { env } from "../../../../shared/config/env";
import { buildHubServerCapabilities } from "../../../../shared/constants/agent_transport_contract";
import { isParallelBatchDispatchNegotiated } from "../../../../shared/constants/transport_extension_negotiation";
import { socketEvents } from "../../../../shared/constants/socket_events";
import {
  noteAgentCapabilityProfile,
  noteAgentRegisterRateLimited,
  noteAgentSessionRejectedActive,
  noteAgentSessionTakeoverDisconnect,
  noteParallelBatchDispatchNegotiated,
} from "../../../../shared/metrics/socket_agent.metrics";
import { logger } from "../../../../shared/utils/logger";
import {
  decodePayloadFrameAsync,
  encodePayloadFrameHotPath,
} from "../../../../shared/utils/payload_frame";
import { agentRegisterPayloadSchema } from "../../../../shared/validators/agent_register";
import type { AgentRegisterProfileSnapshot } from "../../../../application/services/agent_profile_sync.service";
import { syncAgentHubPresenceOnRegister } from "../../../../application/services/agent_hub_presence_sync";
import {
  type AgentHubNamespace,
  type AgentHubSocket,
  getUserId,
  withOptionalRequestId,
} from "./_shared";

export interface AgentRegisterHandlerContext {
  readonly agentsNsp: AgentHubNamespace;
  readonly scheduleAgentProfileSync: (input: {
    readonly agentId: string;
    readonly userId: string | null;
    readonly snapshot?: AgentRegisterProfileSnapshot;
  }) => void;
}

/**
 * Handles `agent:register`: validates the payload and token/agent identity,
 * enforces the per-user register rate limit, binds ownership, registers the
 * session (honoring the configured session policy, including takeover of a
 * superseded socket via `agentsNsp`), stores capabilities/profile snapshot,
 * emits `agent:capabilities`, and—unless the agent opted into the explicit
 * `protocol_ready_ack` handshake—schedules the profile sync.
 *
 * Receives its collaborators (the namespace and the profile-sync scheduler)
 * via {@link AgentRegisterHandlerContext} so the handler keeps no module
 * singleton of its own and the lifecycle stays explicit at the call site.
 */
export const handleAgentRegister = async (
  socket: AgentHubSocket,
  rawPayload: unknown,
  ctx: AgentRegisterHandlerContext,
): Promise<void> => {
  const { agentsNsp, scheduleAgentProfileSync } = ctx;

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
  if (typeof tokenAgentId === "string" && tokenAgentId.trim() !== "" && tokenAgentId !== agentId) {
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

  if (
    agentRegistry.wouldRejectActiveSession({
      agentId,
      socketId: socket.id,
      policy: env.socketAgentSessionPolicy,
      isPeerConnected: (sid) => agentsNsp.sockets.has(sid),
    })
  ) {
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

  let bindResult: Awaited<ReturnType<typeof container.agentAccessService.bindOwnershipOnRegister>>;
  try {
    bindResult = await container.agentAccessService.bindOwnershipOnRegister(userId, agentId);
  } catch (error: unknown) {
    logger.warn("agent_register_ownership_bind_failed", {
      socketId: socket.id,
      agentId,
      userId,
      message: error instanceof Error ? error.message : String(error),
    });
    await refundAgentRegisterRateLimitAsync(userId, agentId);
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
      // Race: peer connected between the peek and register. Refund the
      // attempt so reconnect races do not permanently burn quota.
      await refundAgentRegisterRateLimitAsync(userId, agentId);
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
  if (isParallelBatchDispatchNegotiated(capabilities)) {
    noteParallelBatchDispatchNegotiated();
  }
  const requiresExplicitReadyAck = resolveRequiresExplicitProtocolReadyAck(capabilities);

  logger.info("Agent registered on hub", {
    socketId: socket.id,
    agentId,
    userId,
  });

  const connectedAtMs = Date.parse(registration.agent.connectedAt);
  void syncAgentHubPresenceOnRegister({
    agentId,
    socketId: socket.id,
    connectedAtMs: Number.isFinite(connectedAtMs) ? connectedAtMs : Date.now(),
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
};
