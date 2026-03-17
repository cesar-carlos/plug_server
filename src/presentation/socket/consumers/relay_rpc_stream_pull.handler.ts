import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { requestRelayStreamPull } from "../hub/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

const relayStreamPullEnvelopeSchema = z.object({
  conversationId: nonEmptyStringSchema,
  frame: z.unknown(),
});

type RelayStreamPullResponsePayload =
  | {
      success: true;
      conversationId: string;
      requestId: string;
      streamId: string;
      windowSize: number;
    }
  | { success: false; error: { code: string; message: string; statusCode?: number } };

const emitRelayStreamPullResponse = (socket: Socket, payload: RelayStreamPullResponsePayload): void => {
  socket.emit(socketEvents.relayRpcStreamPullResponse, payload);
};

const resolveRole = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.role === "string" && user.role.trim() !== "" ? user.role : null;

export const handleRelayRpcStreamPull = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const parsed = relayStreamPullEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Validation failed";
    emitRelayStreamPullResponse(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  try {
    const result = requestRelayStreamPull({
      consumerSocketId: socket.id,
      conversationId: parsed.data.conversationId,
      rawFramePayload: parsed.data.frame,
    });

    emitRelayStreamPullResponse(socket, {
      success: true,
      conversationId: parsed.data.conversationId,
      requestId: result.requestId,
      streamId: result.streamId,
      windowSize: result.windowSize,
    });

    const actorRole = resolveRole(socket.data.user);
    void recordSocketAuditEvent({
      eventType: socketEvents.relayRpcStreamPull,
      actorSocketId: socket.id,
      actorUserId: socket.data.user?.sub ?? null,
      ...(actorRole ? { actorRole } : {}),
      direction: "consumer_to_agent",
      conversationId: parsed.data.conversationId,
      requestId: result.requestId,
      streamId: result.streamId,
      payload: { windowSize: result.windowSize },
    });
  } catch (err: unknown) {
    const appError = err instanceof AppError ? err : undefined;
    emitRelayStreamPullResponse(socket, {
      success: false,
      error: {
        code: appError?.code ?? "RELAY_STREAM_PULL_FAILED",
        message: err instanceof Error ? err.message : "Failed to pull stream",
        ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
      },
    });
  }
};
