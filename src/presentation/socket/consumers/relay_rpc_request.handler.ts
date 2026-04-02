import type { Socket } from "socket.io";
import { z } from "zod";

import { createBridgeLatencyTraceIfSampled } from "../../../application/services/bridge_latency_trace_builder";
import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { dispatchRelayRpcToAgent } from "../hub/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import { payloadFrameCompressionSchema } from "../../../shared/validators/agent_command";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { conversationRegistry } from "../hub/conversation_registry";
import type { AgentAccessPrincipal } from "../../../application/services/agent_access.service";
import { container } from "../../../shared/di/container";

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

const resolveAgentAccessPrincipal = (
  user: JwtAccessPayload | undefined,
): AgentAccessPrincipal | null => {
  if (typeof user?.sub !== "string" || user.sub.trim() === "") {
    return null;
  }
  return user.principal_type === "client"
    ? { type: "client", id: user.sub }
    : { type: "user", id: user.sub, ...(user.role !== undefined ? { role: user.role } : {}) };
};

export const handleRelayRpcRequest = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const parsed = relayRpcEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitRelayRpcAccepted(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;
  const latencyTrace = createBridgeLatencyTraceIfSampled({
    channel: "relay",
    userId: userSub,
  });

  void (async () => {
    try {
      const principal = resolveAgentAccessPrincipal(socket.data.user);
      if (!principal) {
        throw new AppError("Authentication required", { code: "UNAUTHORIZED", statusCode: 401 });
      }
      const conversation = conversationRegistry.findInternalByConversationId(parsed.data.conversationId);
      if (!conversation || conversation.consumerSocketId !== socket.id) {
        throw new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 });
      }
      const accessResult = await container.agentAccessService.assertPrincipalAccess(
        principal,
        conversation.agentId,
      );
      if (!accessResult.ok) {
        throw accessResult.error;
      }

      const result = await dispatchRelayRpcToAgent({
        conversationId: parsed.data.conversationId,
        consumerSocketId: socket.id,
        rawFramePayload: parsed.data.frame,
        ...(parsed.data.payloadFrameCompression !== undefined
          ? { payloadFrameCompression: parsed.data.payloadFrameCompression }
          : {}),
        ...(latencyTrace ? { latencyTrace } : {}),
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
      if (latencyTrace && !latencyTrace.isFinalized()) {
        if (latencyTrace.hasDispatchMeta()) {
          latencyTrace.finalizeOnce({
            outcome: "error",
            ...(typeof appError?.statusCode === "number"
              ? { httpStatus: appError.statusCode }
              : {}),
            errorCode: appError?.code ?? "RELAY_RPC_REQUEST_FAILED",
          });
        } else {
          latencyTrace.dismissWithoutPersist();
        }
      }
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
