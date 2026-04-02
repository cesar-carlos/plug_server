import type { Namespace, Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { conflict, notFound, serviceUnavailable } from "../../../shared/errors/http_errors";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import { agentRegistry } from "../hub/agent_registry";
import { conversationRegistry } from "../hub/conversation_registry";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import {
  assertConsumerSocketAgentAccess,
  resolveSocketActorRole,
} from "./consumer_socket_guard";

const conversationStartPayloadSchema = z.object({
  agentId: nonEmptyStringSchema,
});

const emitConversationStarted = (
  socket: Socket,
  payload:
    | {
        success: true;
        conversationId: string;
        agentId: string;
        createdAt: string;
      }
    | {
        success: false;
        error: { code: string; message: string; statusCode?: number };
      },
): void => {
  socket.emit(socketEvents.relayConversationStarted, payload);
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, { message, code });
};

export const handleRelayConversationStart = async (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
  agentsNamespace: Namespace,
): Promise<void> => {
  const parsed = conversationStartPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitAppError(socket, message, "VALIDATION_ERROR");
    return;
  }

  try {
    if (conversationRegistry.countAll() >= env.socketRelayMaxConversations) {
      throw serviceUnavailable("Relay conversation capacity reached");
    }

    if (
      conversationRegistry.countByConsumerSocketId(socket.id) >=
      env.socketRelayMaxConversationsPerConsumer
    ) {
      throw conflict("Consumer reached max active relay conversations");
    }

    await assertConsumerSocketAgentAccess(socket.data.user, parsed.data.agentId);

    const registeredAgent = agentRegistry.findByAgentId(parsed.data.agentId);
    if (!registeredAgent) {
      throw notFound(`Agent ${parsed.data.agentId}`);
    }

    const agentSocket = agentsNamespace.sockets.get(registeredAgent.socketId);
    if (!agentSocket) {
      throw serviceUnavailable("Agent socket is unavailable");
    }

    const conversation = conversationRegistry.create({
      consumerSocketId: socket.id,
      agentSocketId: registeredAgent.socketId,
      agentId: parsed.data.agentId,
    });

    emitConversationStarted(socket, {
      success: true,
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
    const appError = err instanceof AppError ? err : undefined;
    emitConversationStarted(socket, {
      success: false,
      error: {
        code: appError?.code ?? "CONVERSATION_START_FAILED",
        message: err instanceof Error ? err.message : "Failed to start conversation",
        ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
      },
    });
  }
};
