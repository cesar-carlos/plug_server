import type { Socket } from "socket.io";
import { z } from "zod";

import { createBridgeLatencyTraceIfSampled } from "../../../application/services/bridge_latency_trace_builder";
import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { dispatchRelayRpcToAgent } from "../hub/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { conversationIdSchema } from "../../../shared/validators/schemas";
import { payloadFrameCompressionSchema } from "../../../shared/validators/agent_command";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { conversationRegistry } from "../hub/conversation_registry";
import { refundRelayRpcRequest } from "../hub/consumer_relay_rate_limiter";
import { assertConsumerSocketAgentAccess, resolveSocketActorRole } from "./consumer_socket_guard";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";

export const relayRpcEnvelopeSchema = z.object({
  conversationId: conversationIdSchema,
  frame: z.unknown(),
  payloadFrameCompression: payloadFrameCompressionSchema.optional(),
});

export type RelayRpcRequestEnvelope = z.infer<typeof relayRpcEnvelopeSchema>;

type RelayRpcAcceptedPayload =
  | {
      success: true;
      conversationId: string;
      requestId: string;
      clientRequestId?: string;
      deduplicated?: boolean;
      replayed?: boolean;
      inFlight?: boolean;
    }
  | { success: false; error: { code: string; message: string; statusCode?: number } };

const emitRelayRpcAccepted = (socket: Socket, payload: RelayRpcAcceptedPayload): void => {
  socket.emit(socketEvents.relayRpcAccepted, payload);
};

export const parseRelayRpcRequestEnvelope = (
  rawPayload: unknown,
):
  | { success: true; data: RelayRpcRequestEnvelope }
  | { success: false; errorMessage: string } => {
  const parsed = relayRpcEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    return { success: false, errorMessage: message };
  }
  return { success: true, data: parsed.data };
};

export const handleRelayRpcRequest = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;
  const envelope = parseRelayRpcRequestEnvelope(rawPayload);
  if (!envelope.success) {
    emitRelayRpcAccepted(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
    });
    return;
  }
  const parsed = { success: true as const, data: envelope.data };

  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
    refundRelayRpcRequest(userSub, socket.id);
    emitRelayRpcAccepted(socket, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
    return;
  }
  const latencyTrace = createBridgeLatencyTraceIfSampled({
    channel: "relay",
    userId: userSub,
  });

  void (async () => {
    try {
      const conversation = conversationRegistry.findInternalByConversationId(
        parsed.data.conversationId,
      );
      if (!conversation || conversation.consumerSocketId !== socket.id) {
        throw new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 });
      }

      await assertConsumerSocketAgentAccess(socket.data.user, conversation.agentId, socket);

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
        ...(result.inFlight ? { inFlight: true } : {}),
      });
      if (result.deduplicated) {
        refundRelayRpcRequest(userSub, socket.id);
      }

      const actorRole = resolveSocketActorRole(socket.data.user);
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
      if (appError?.statusCode === 400) {
        refundRelayRpcRequest(userSub, socket.id);
      }
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
    } finally {
      releaseSocketInflightSlot(socket);
    }
  })();
};
