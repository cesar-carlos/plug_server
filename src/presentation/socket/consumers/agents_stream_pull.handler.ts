import type { Socket } from "socket.io";
import { z } from "zod";

import { prepareLegacyAgentStreamPull } from "../hub/rpc_bridge";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
} from "../hub/active_stream_registry";
import { agentRegistry } from "../hub/agent_registry";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import { AppError } from "../../../shared/errors/app_error";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { allowAgentsCommandSocketAsync } from "../hub/agents_command_socket_rate_limiter";
import {
  allowAgentsStreamPullCredits,
  refundAgentsStreamPullCredits,
} from "../hub/consumer_relay_rate_limiter";
import { assertConsumerSocketAgentAccess } from "./consumer_socket_guard";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";
import { resolveAppErrorRetryAfterMs } from "./socket_retry_after";
import { noteSocketErrorRetryAfterMsPropagated } from "../../../shared/metrics/socket_consumer.metrics";

const streamPullPayloadSchema = z
  .object({
    streamId: nonEmptyStringSchema.optional(),
    requestId: nonEmptyStringSchema.optional(),
    windowSize: z.coerce.number().int().positive().max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.streamId && !value.requestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["streamId"],
        message: "Provide streamId or requestId",
      });
    }
  });

type StreamPullResponsePayload =
  | {
      success: true;
      requestId: string;
      streamId: string;
      windowSize: number;
      rateLimit?: {
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

const emitStreamPullResponse = (socket: Socket, payload: StreamPullResponsePayload): void => {
  socket.emit(socketEvents.agentsStreamPullResponse, payload);
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, { message, code });
};

const resolveStreamRouteAgentId = (payload: {
  readonly streamId?: string;
  readonly requestId?: string;
}): string | null => {
  const resolvedStreamId = payload.streamId ? toRequestId(payload.streamId) : null;
  const resolvedRequestId = payload.requestId ? toRequestId(payload.requestId) : null;
  const route = resolvedStreamId
    ? getActiveStreamRouteByStreamId(resolvedStreamId)
    : resolvedRequestId
      ? getActiveStreamRouteByRequestId(resolvedRequestId)
      : undefined;

  if (!route) {
    return null;
  }

  return agentRegistry.findBySocketId(route.agentSocketId)?.agentId ?? null;
};

export const handleAgentsStreamPull = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): void => {
  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;
  if (!isRecord(rawPayload)) {
    emitAppError(socket, "agents:stream_pull payload must be an object");
    return;
  }

  const parsed = streamPullPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitStreamPullResponse(socket, {
      success: false,
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
    emitStreamPullResponse(socket, {
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
    let grantedCredits = 0;
    try {
      if (!(await allowAgentsCommandSocketAsync(userSub, socket.id))) {
        emitStreamPullResponse(socket, {
          success: false,
          error: {
            code: "TOO_MANY_REQUESTS",
            message: "Too many agent stream pulls, please try again later.",
            statusCode: 429,
          },
        });
        return;
      }

      assertNotAborted();
      const agentId = resolveStreamRouteAgentId({
        ...(parsed.data.streamId ? { streamId: parsed.data.streamId } : {}),
        ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
      });
      if (!agentId) {
        throw new AppError("Stream route not found", { code: "NOT_FOUND", statusCode: 404 });
      }

      await assertConsumerSocketAgentAccess(socket.data.user, agentId, socket);
      assertNotAborted();

      const prepared = prepareLegacyAgentStreamPull({
        consumerSocketId: socket.id,
        ...(parsed.data.streamId ? { streamId: parsed.data.streamId } : {}),
        ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
        ...(parsed.data.windowSize !== undefined ? { windowSize: parsed.data.windowSize } : {}),
      });
      const allowance = await allowAgentsStreamPullCredits(
        userSub,
        socket.id,
        prepared.windowSize,
      );
      if (!allowance.allowed) {
        emitStreamPullResponse(socket, {
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
      grantedCredits = allowance.grantedCredits;
      const result = prepared.execute();

      emitStreamPullResponse(socket, {
        success: true,
        requestId: result.requestId,
        streamId: result.streamId,
        windowSize: result.windowSize,
        ...(allowance.limit > 0
          ? {
              rateLimit: {
                remainingCredits: allowance.remainingCredits,
                limit: allowance.limit,
                scope: allowance.scope,
              },
            }
          : {}),
      });
    } catch (err: unknown) {
      if (grantedCredits > 0) {
        await refundAgentsStreamPullCredits(userSub, socket.id, grantedCredits);
      }
      const appError = err instanceof AppError ? err : undefined;
      const code = appError?.code ?? "STREAM_PULL_FAILED";
      const message = err instanceof Error ? err.message : "Failed to pull stream";
      const statusCode = appError?.statusCode;
      const retryAfterMs = resolveAppErrorRetryAfterMs(err);
      if (retryAfterMs !== undefined) {
        noteSocketErrorRetryAfterMsPropagated();
      }

      emitStreamPullResponse(socket, {
        success: false,
        error: {
          code,
          message,
          ...(typeof statusCode === "number" ? { statusCode } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      });
    } finally {
      unregisterAbortController();
      releaseSocketInflightSlot(socket);
    }
  })();
};
