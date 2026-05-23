import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { notFound } from "../../../shared/errors/http_errors";
import { AppError } from "../../../shared/errors/app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { conversationIdSchema } from "../../../shared/validators/schemas";
import { conversationRegistry } from "../hub/conversation_registry";
import { cleanupConversationStreamSubscriptions } from "../hub/rpc_bridge";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

export const conversationEndPayloadSchema = z
  .object({
    conversationId: conversationIdSchema,
    requestId: z.string().min(1).optional(),
  })
  .passthrough();

export type RelayConversationEndEnvelope = z.infer<typeof conversationEndPayloadSchema>;

export const parseRelayConversationEndEnvelope = (
  rawPayload: unknown,
):
  | { success: true; data: RelayConversationEndEnvelope }
  | { success: false; errorMessage: string } => {
  const parsed = conversationEndPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    return { success: false, errorMessage: message };
  }
  return { success: true, data: parsed.data };
};

const withOptionalRequestId = (
  requestId: string | undefined,
): { readonly requestId?: string } => (requestId ? { requestId } : {});

const emitConversationEnded = (
  socket: Socket,
  requestId: string | undefined,
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
  if (!socket.connected) {
    return;
  }
  socket.emit(socketEvents.relayConversationEnded, {
    ...payload,
    ...withOptionalRequestId(requestId),
  });
};

const resolveRole = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.role === "string" && user.role.trim() !== "" ? user.role : null;

export const handleRelayConversationEnd = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const envelope = parseRelayConversationEndEnvelope(rawPayload);
  const requestId =
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    typeof (rawPayload as Record<string, unknown>).requestId === "string"
      ? String((rawPayload as Record<string, unknown>).requestId)
      : undefined;
  if (!envelope.success) {
    emitConversationEnded(socket, requestId, {
      success: false,
      error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
    });
    return;
  }
  const parsed = { success: true as const, data: envelope.data };
  const resolvedRequestId = parsed.data.requestId ?? requestId;

  try {
    const conversation = conversationRegistry.findByConversationId(parsed.data.conversationId);
    if (!conversation || conversation.consumerSocketId !== socket.id) {
      throw notFound("Conversation");
    }

    conversationRegistry.removeByConversationId(conversation.conversationId);
    cleanupConversationStreamSubscriptions(conversation.conversationId);
    emitConversationEnded(socket, resolvedRequestId, {
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
    emitConversationEnded(socket, resolvedRequestId, {
      success: false,
      error: {
        code: appError?.code ?? "CONVERSATION_END_FAILED",
        message: err instanceof Error ? err.message : "Failed to end conversation",
        ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
      },
    });
  }
};
