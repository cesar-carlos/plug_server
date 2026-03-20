import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { dispatchRelayRpcToAgent } from "../hub/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import { payloadFrameCompressionSchema } from "../../../shared/validators/agent_command";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

const relayRpcEnvelopeSchema = z.object({
  conversationId: nonEmptyStringSchema,
  frame: z.unknown(),
  payloadFrameCompression: payloadFrameCompressionSchema.optional(),
});

type RelayRpcAcceptedPayload =
  | {
      success: true;
      conversationId: string;
      requestId: string;
      clientRequestId?: string;
      deduplicated?: boolean;
      replayed?: boolean;
    }
  | { success: false; error: { code: string; message: string; statusCode?: number } };

const emitRelayRpcAccepted = (socket: Socket, payload: RelayRpcAcceptedPayload): void => {
  socket.emit(socketEvents.relayRpcAccepted, payload);
};

const resolveRole = (user: JwtAccessPayload | undefined): string | null =>
  typeof user?.role === "string" && user.role.trim() !== "" ? user.role : null;

export const handleRelayRpcRequest = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const parsed = relayRpcEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Validation failed";
    emitRelayRpcAccepted(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  void (async () => {
    try {
      const result = await dispatchRelayRpcToAgent({
        conversationId: parsed.data.conversationId,
        consumerSocketId: socket.id,
        rawFramePayload: parsed.data.frame,
        ...(parsed.data.payloadFrameCompression !== undefined
          ? { payloadFrameCompression: parsed.data.payloadFrameCompression }
          : {}),
      });

      emitRelayRpcAccepted(socket, {
        success: true,
        conversationId: parsed.data.conversationId,
        requestId: result.requestId,
        ...(result.clientRequestId ? { clientRequestId: result.clientRequestId } : {}),
        ...(result.deduplicated ? { deduplicated: true } : {}),
        ...(result.replayed ? { replayed: true } : {}),
      });

      const actorRole = resolveRole(socket.data.user);
      void recordSocketAuditEvent({
        eventType: socketEvents.relayRpcRequest,
        actorSocketId: socket.id,
        actorUserId: socket.data.user?.sub ?? null,
        ...(actorRole ? { actorRole } : {}),
        direction: "consumer_to_agent",
        conversationId: parsed.data.conversationId,
        requestId: result.requestId,
        payload: {
          clientRequestId: result.clientRequestId ?? null,
          deduplicated: result.deduplicated === true,
          replayed: result.replayed === true,
        },
      });
    } catch (err: unknown) {
      const appError = err instanceof AppError ? err : undefined;
      emitRelayRpcAccepted(socket, {
        success: false,
        error: {
          code: appError?.code ?? "RELAY_RPC_REQUEST_FAILED",
          message: err instanceof Error ? err.message : "Failed to relay request",
          ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
        },
      });
    }
  })();
};
