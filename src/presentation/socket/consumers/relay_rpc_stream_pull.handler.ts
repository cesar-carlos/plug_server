import type { Socket } from "socket.io";
import { z } from "zod";

import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { prepareRelayStreamPull } from "../hub/relay/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { conversationIdSchema } from "../../../shared/validators/schemas";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import {
  allowRelayStreamPullAsync,
  refundRelayStreamPullCreditsAsync,
} from "../hub/rate_limits/consumer_relay_rate_limiter";
import { conversationRegistry } from "../hub/registries/conversation_registry";
import { assertConsumerSocketAgentAccess, resolveSocketActorRole } from "./consumer_socket_guard";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";
import { resolveAppErrorRetryAfterMs } from "./socket_retry_after";
import { noteSocketErrorRetryAfterMsPropagated } from "../../../shared/metrics/socket_consumer.metrics";

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
      error: { code: string; message: string; statusCode?: number; retryAfterMs?: number };
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
  if (socket.connected === false) {
    return;
  }
  socket.emit(socketEvents.relayRpcStreamPullResponse, payload);
};

export const handleRelayRpcStreamPull = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  envelope: RelayRpcStreamPullEnvelope,
): void => {
  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;

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
  const abortController = new AbortController();
  const unregisterAbortController = registerConsumerCommandAbortController(
    socket.id,
    abortController,
  );
  const assertNotAborted = (): void => {
    if (abortController.signal.aborted) {
      throw new AppError("Consumer socket disconnected before stream pull completed", {
        code: "SERVICE_UNAVAILABLE",
        statusCode: 503,
      });
    }
  };

  void (async () => {
    try {
      assertNotAborted();
      const conversation = conversationRegistry.findInternalByConversationId(
        envelope.conversationId,
      );
      if (!conversation || conversation.consumerSocketId !== socket.id) {
        throw new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 });
      }

      await assertConsumerSocketAgentAccess(socket.data.user, conversation.agentId, socket);
      assertNotAborted();

      const prepared = await prepareRelayStreamPull({
        consumerSocketId: socket.id,
        conversationId: envelope.conversationId,
        rawFramePayload: envelope.frame,
      });
      assertNotAborted();

      const allowance = await allowRelayStreamPullAsync(userSub, socket.id, prepared.windowSize);
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

      let result;
      try {
        assertNotAborted();
        result = prepared.execute();
      } catch (error) {
        await refundRelayStreamPullCreditsAsync(userSub, socket.id, allowance.grantedCredits);
        throw error;
      }

      emitRelayStreamPullResponse(socket, {
        success: true,
        conversationId: envelope.conversationId,
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
        conversationId: envelope.conversationId,
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
      const retryAfterMs = resolveAppErrorRetryAfterMs(err);
      if (retryAfterMs !== undefined) {
        noteSocketErrorRetryAfterMsPropagated();
      }
      emitRelayStreamPullResponse(socket, {
        success: false,
        error: {
          code: appError?.code ?? "RELAY_STREAM_PULL_FAILED",
          message: err instanceof Error ? err.message : "Failed to pull stream",
          ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      });
    } finally {
      unregisterAbortController();
      releaseSocketInflightSlot(socket);
    }
  })();
};
