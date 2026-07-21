import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { conflict, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { agentIdSchema } from "../../../shared/validators/schemas";
import { agentRegistry } from "../hub/registries/agent_registry";
import { refundRelayConversationStartAsync } from "../hub/rate_limits/consumer_relay_rate_limiter";
import { conversationRegistry } from "../hub/registries/conversation_registry";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { assertConsumerSocketAgentAccess, resolveSocketActorRole } from "./consumer_socket_guard";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";
import { resolveAppErrorRetryAfterMs } from "./socket_retry_after";
import { noteSocketErrorRetryAfterMsPropagated } from "../../../shared/metrics/socket_consumer.metrics";
import { noteRelayConversationStartRemoteHub } from "../../../shared/metrics/socket_consumer.metrics";
import { resolveAgentHubPresenceRoute } from "../../../application/services/agent_hub_presence_sync";
import { findAgentBridgeSocketById } from "../hub/relay/rpc_bridge";

/**
 * Rate-limit refund policy for `relay:conversation.start` after quota was consumed:
 * - **Refund**: non-`AppError` (unexpected / transient) and `AppError` outside the 4xx range (e.g. 503).
 * - **No refund**: any **4xx** (404 agent missing, 409 per-consumer cap, auth/forbidden, etc.).
 *
 * Envelope `VALIDATION_ERROR` is rejected before quota consumption in `socket.ts`.
 */
export const shouldRefundRelayConversationStartRateLimit = (error: unknown): boolean => {
  if (!(error instanceof AppError)) {
    return true;
  }
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }
  return true;
};

export const conversationStartPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128).optional(),
  agentId: agentIdSchema,
});

export type RelayConversationStartEnvelope = z.infer<typeof conversationStartPayloadSchema>;

const relayConversationStartRequestIdMaxLength = 128;

export const parseRelayConversationStartEnvelope = (
  rawPayload: unknown,
):
  | { success: true; data: RelayConversationStartEnvelope }
  | { success: false; errorMessage: string } => {
  const parsed = conversationStartPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    return { success: false, errorMessage: message };
  }
  return { success: true, data: parsed.data };
};

export const extractRelayConversationStartRequestId = (rawPayload: unknown): string | undefined => {
  if (typeof rawPayload !== "object" || rawPayload === null) {
    return undefined;
  }
  const requestId = (rawPayload as Record<string, unknown>).requestId;
  if (typeof requestId !== "string") {
    return undefined;
  }
  const trimmed = requestId.trim();
  return trimmed !== "" && trimmed.length <= relayConversationStartRequestIdMaxLength
    ? trimmed
    : undefined;
};

const withOptionalRequestId = (requestId: string | undefined): { readonly requestId?: string } =>
  requestId !== undefined ? { requestId } : {};

const emitConversationStarted = (
  socket: Socket,
  payload:
    | {
        success: true;
        requestId?: string;
        conversationId: string;
        agentId: string;
        createdAt: string;
      }
    | {
        success: false;
        requestId?: string;
        error: { code: string; message: string; statusCode?: number; retryAfterMs?: number };
      },
): void => {
  socket.emit(socketEvents.relayConversationStarted, payload);
};

export const handleRelayConversationStart = async (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  envelope: RelayConversationStartEnvelope,
): Promise<void> => {
  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
    emitConversationStarted(socket, {
      success: false,
      ...withOptionalRequestId(envelope.requestId),
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
    return;
  }
  const abortController = new AbortController();
  const unregisterAbortController = registerConsumerCommandAbortController(
    socket.id,
    abortController,
  );
  const assertNotAborted = (): void => {
    if (abortController.signal.aborted) {
      throw serviceUnavailable("Consumer socket disconnected before conversation start completed");
    }
  };

  try {
    assertNotAborted();
    await assertConsumerSocketAgentAccess(socket.data.user, envelope.agentId, socket);
    assertNotAborted();

    const registeredAgent = agentRegistry.findByAgentId(envelope.agentId);
    if (!registeredAgent) {
      const remoteRoute = await resolveAgentHubPresenceRoute(envelope.agentId);
      if (
        remoteRoute !== null &&
        remoteRoute.hubInstanceId.trim() !== "" &&
        remoteRoute.hubInstanceId !== env.hubInstanceId
      ) {
        noteRelayConversationStartRemoteHub();
        throw serviceUnavailable(
          `Agent ${envelope.agentId} is connected on another hub instance; relay conversations require sticky session affinity to that hub`,
        );
      }
      throw notFound(`Agent ${envelope.agentId}`);
    }

    const agentSocket = findAgentBridgeSocketById(registeredAgent.socketId);
    if (!agentSocket) {
      throw serviceUnavailable("Agent socket is unavailable");
    }

    assertNotAborted();
    // Atomic reserve+create: check global + per-consumer caps and insert in
    // one synchronous step (no TOCTOU between counts and registry insert).
    const reservation = conversationRegistry.tryReserveAndCreate({
      consumerSocketId: socket.id,
      agentSocketId: registeredAgent.socketId,
      agentId: envelope.agentId,
      maxTotal: env.socketRelayMaxConversations,
      maxPerConsumer: env.socketRelayMaxConversationsPerConsumer,
    });
    if (!reservation.ok) {
      throw reservation.reason === "global_cap_reached"
        ? serviceUnavailable("Relay conversation capacity reached")
        : conflict("Consumer reached max active relay conversations");
    }
    const conversation = reservation.conversation;

    emitConversationStarted(socket, {
      success: true,
      ...withOptionalRequestId(envelope.requestId),
      conversationId: conversation.conversationId,
      agentId: conversation.agentId,
      createdAt: conversation.createdAt,
    });

    const actorRole = resolveSocketActorRole(socket.data.user);
    void recordSocketAuditEvent({
      eventType: socketEvents.relayConversationStart,
      actorSocketId: socket.id,
      actorUserId: socket.data.user?.sub ?? null,
      ...(actorRole ? { actorRole } : {}),
      direction: "control",
      conversationId: conversation.conversationId,
      agentId: conversation.agentId,
      payload: { createdAt: conversation.createdAt },
    });
  } catch (err: unknown) {
    if (shouldRefundRelayConversationStartRateLimit(err)) {
      await refundRelayConversationStartAsync(socket.data.user?.sub, socket.id);
    }
    const appError = err instanceof AppError ? err : undefined;
    const retryAfterMs = resolveAppErrorRetryAfterMs(err);
    if (retryAfterMs !== undefined) {
      noteSocketErrorRetryAfterMsPropagated();
    }
    emitConversationStarted(socket, {
      success: false,
      ...withOptionalRequestId(envelope.requestId),
      error: {
        code: appError?.code ?? "CONVERSATION_START_FAILED",
        message: err instanceof Error ? err.message : "Failed to start conversation",
        ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    });
  } finally {
    unregisterAbortController();
    releaseSocketInflightSlot(socket);
  }
};
