import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { prepareRelayStreamPull } from "../hub/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { conversationIdSchema } from "../../../shared/validators/schemas";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { allowRelayStreamPull } from "../hub/consumer_relay_rate_limiter";
import { conversationRegistry } from "../hub/conversation_registry";
import { assertConsumerSocketAgentAccess, resolveSocketActorRole } from "./consumer_socket_guard";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";

export const relayStreamPullEnvelopeSchema = z.object({
  conversationId: conversationIdSchema,
  frame: z.unknown(),
});

export type RelayRpcStreamPullEnvelope = z.infer<typeof relayStreamPullEnvelopeSchema>;

export const parseRelayRpcStreamPullEnvelope = (
  rawPayload: unknown,
):
  | { success: true; data: RelayRpcStreamPullEnvelope }
  | { success: false; errorMessage: string } => {
  const parsed = relayStreamPullEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    return { success: false, errorMessage: message };
  }
  return { success: true, data: parsed.data };
};

type RelayStreamPullResponsePayload =
  | {
      success: true;
      conversationId: string;
      requestId: string;
      streamId: string;
      windowSize: number;
      rateLimit: {
        remainingCredits: number;
        limit: number;
        scope: "user" | "anon";
      };
    }
  | {
      success: false;
      error: { code: string; message: string; statusCode?: number };
      rateLimit?: {
        remainingCredits: number;
        limit: number;
        scope: "user" | "anon";
      };
    };

const emitRelayStreamPullResponse = (
  socket: Socket,
  payload: RelayStreamPullResponsePayload,
): void => {
  socket.emit(socketEvents.relayRpcStreamPullResponse, payload);
};

export const handleRelayRpcStreamPull = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const envelope = parseRelayRpcStreamPullEnvelope(rawPayload);
  if (!envelope.success) {
    emitRelayStreamPullResponse(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message: envelope.errorMessage },
    });
    return;
  }
  const parsed = { success: true as const, data: envelope.data };

  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
    emitRelayStreamPullResponse(socket, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
    return;
  }

  void (async () => {
    try {
      const conversation = conversationRegistry.findInternalByConversationId(
        parsed.data.conversationId,
      );
      if (!conversation || conversation.consumerSocketId !== socket.id) {
        throw new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 });
      }

      await assertConsumerSocketAgentAccess(socket.data.user, conversation.agentId, socket);

      const prepared = await prepareRelayStreamPull({
        consumerSocketId: socket.id,
        conversationId: parsed.data.conversationId,
        rawFramePayload: parsed.data.frame,
      });

      const userSub = socket.data.user?.sub;
      const allowance = allowRelayStreamPull(userSub, socket.id, prepared.windowSize);
      if (!allowance.allowed) {
        emitRelayStreamPullResponse(socket, {
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: "Stream pull credit budget exceeded for this window",
            statusCode: 429,
          },
          rateLimit: {
            remainingCredits: allowance.remainingCredits,
            limit: allowance.limit,
            scope: allowance.scope,
          },
        });
        return;
      }

      const result = prepared.execute();

      emitRelayStreamPullResponse(socket, {
        success: true,
        conversationId: parsed.data.conversationId,
        requestId: result.requestId,
        streamId: result.streamId,
        windowSize: result.windowSize,
        rateLimit: {
          remainingCredits: allowance.remainingCredits,
          limit: allowance.limit,
          scope: allowance.scope,
        },
      });

      const actorRole = resolveSocketActorRole(socket.data.user);
      void recordSocketAuditEvent({
        eventType: socketEvents.relayRpcStreamPull,
        actorSocketId: socket.id,
        actorUserId: socket.data.user?.sub ?? null,
        ...(actorRole ? { actorRole } : {}),
        direction: "consumer_to_agent",
        conversationId: parsed.data.conversationId,
        requestId: result.requestId,
        streamId: result.streamId,
        payload: {
          windowSize: result.windowSize,
          remainingCredits: allowance.remainingCredits,
          limit: allowance.limit,
          scope: allowance.scope,
        },
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
    } finally {
      releaseSocketInflightSlot(socket);
    }
  })();
};
