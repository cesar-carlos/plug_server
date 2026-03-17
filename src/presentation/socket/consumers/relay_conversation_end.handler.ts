import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { notFound } from "../../../shared/errors/http_errors";
import { AppError } from "../../../shared/errors/app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import { conversationRegistry } from "../hub/conversation_registry";
import { cleanupConversationStreamSubscriptions } from "../hub/rpc_bridge";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

const conversationEndPayloadSchema = z.object({
  conversationId: nonEmptyStringSchema,
});

const emitConversationEnded = (
  socket: Socket,
  payload:
    | {
        success: true;
        conversationId: string;
        reason: "consumer_ended";
      }
    | {
        success: false;
        error: { code: string; message: string; statusCode?: number };
      },
): void => {
  socket.emit(socketEvents.relayConversationEnded, payload);
};

const resolveRole = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.role === "string" && user.role.trim() !== "" ? user.role : null;

export const handleRelayConversationEnd = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const parsed = conversationEndPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Validation failed";
    emitConversationEnded(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  try {
    const conversation = conversationRegistry.findByConversationId(parsed.data.conversationId);
    if (!conversation || conversation.consumerSocketId !== socket.id) {
      throw notFound("Conversation not found");
    }

    conversationRegistry.removeByConversationId(conversation.conversationId);
    cleanupConversationStreamSubscriptions(conversation.conversationId);
    emitConversationEnded(socket, {
      success: true,
      conversationId: conversation.conversationId,
      reason: "consumer_ended",
    });

    const actorRole = resolveRole(socket.data.user);
    void recordSocketAuditEvent({
      eventType: socketEvents.relayConversationEnd,
      actorSocketId: socket.id,
      actorUserId: socket.data.user?.sub ?? null,
      ...(actorRole ? { actorRole } : {}),
      direction: "control",
      conversationId: conversation.conversationId,
      agentId: conversation.agentId,
      payload: { reason: "consumer_ended" },
    });
  } catch (err: unknown) {
    const appError = err instanceof AppError ? err : undefined;
    emitConversationEnded(socket, {
      success: false,
      error: {
        code: appError?.code ?? "CONVERSATION_END_FAILED",
        message: err instanceof Error ? err.message : "Failed to end conversation",
        ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
      },
    });
  }
};
