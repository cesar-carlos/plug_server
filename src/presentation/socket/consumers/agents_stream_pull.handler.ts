/**
 * Socket handler for consumer stream pulls on active agent streams.
 *
 * Wire format: outbound `agents:stream_pull_response` uses `PayloadFrame` by default (hot path);
 * inbound `agents:stream_pull` accepts both plain JSON (legacy) and `PayloadFrame` during migration.
 * Set `SOCKET_AGENTS_STREAM_PULL_COMPAT_MODE=raw_json` for legacy outbound plain JSON.
 * See `agentsStreamPullWireMigration` in `agent_bridge_parity.ts`.
 */

import type { Socket } from "socket.io";
import { z } from "zod";

import { prepareLegacyAgentStreamPull } from "../hub/relay/rpc_bridge";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
} from "../hub/registries/active_stream_registry";
import { agentRegistry } from "../hub/registries/agent_registry";
import { env } from "../../../shared/config/env";
import { buildLegacySocketAppErrorPayload } from "../../../shared/constants/socket_app_error";
import { socketEvents } from "../../../shared/constants/socket_events";
import { toRequestId } from "../../../shared/utils/rpc_types";
import { AppError } from "../../../shared/errors/app_error";
import { nonEmptyStringSchema } from "../../../shared/validators/schemas";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { allowAgentsCommandSocketAsync, refundAgentsCommandSocketAsync } from "../hub/rate_limits/agents_command_socket_rate_limiter";
import {
  allowAgentsStreamPullCredits,
  refundAgentsStreamPullCredits,
} from "../hub/rate_limits/consumer_relay_rate_limiter";
import { logger } from "../../../shared/utils/logger";
import { assertConsumerSocketAgentAccess } from "./consumer_socket_guard";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";
import { resolveAppErrorRetryAfterMs } from "./socket_retry_after";
import { noteSocketErrorRetryAfterMsPropagated } from "../../../shared/metrics/socket_consumer.metrics";
import {
  buildAgentsStreamPullResponseForWire,
  decodeAgentsStreamPullInboundPayload,
  extractAgentsStreamPullRequestId,
  type AgentsStreamPullResponsePayload,
} from "./agents_stream_pull_wire";
import { touchConsumerRegistryOnSocketActivity } from "../hub/scheduling/consumer_idle_touch_events";

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

const emitStreamPullResponse = (
  socket: Socket,
  payload: AgentsStreamPullResponsePayload,
  options?: { readonly requestId?: string },
): void => {
  if (socket.connected === false) {
    return;
  }
  const requestId =
    options?.requestId ??
    ("requestId" in payload && typeof payload.requestId === "string"
      ? payload.requestId
      : undefined);
  socket.emit(
    socketEvents.agentsStreamPullResponse,
    buildAgentsStreamPullResponseForWire(payload, {
      ...(requestId !== undefined ? { requestId } : {}),
    }),
  );
};

const emitAppError = (socket: Socket, message: string, code = "SOCKET_PROTOCOL_ERROR"): void => {
  socket.emit(socketEvents.appError, buildLegacySocketAppErrorPayload(code, message));
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
): Promise<void> => runAgentsStreamPull(socket, rawPayload);

const runAgentsStreamPull = async (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  rawPayload: unknown,
): Promise<void> => {
  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;
  const decodedInbound = await decodeAgentsStreamPullInboundPayload(rawPayload);
  if (!decodedInbound.ok) {
    emitAppError(socket, decodedInbound.message);
    return;
  }

  const correlationRequestId = extractAgentsStreamPullRequestId(decodedInbound.data);
  const parsed = streamPullPayloadSchema.safeParse(decodedInbound.data);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitStreamPullResponse(
      socket,
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message },
      },
      { ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}) },
    );
    return;
  }

  // Valid pull envelope counts as meaningful activity (not malformed spam).
  touchConsumerRegistryOnSocketActivity(socket.id);

  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
    emitStreamPullResponse(
      socket,
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Per-socket inflight gate exceeded",
          statusCode: 429,
        },
      },
      { ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}) },
    );
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
    let commandQuotaConsumed = false;
    try {
      if (!(await allowAgentsCommandSocketAsync(userSub, socket.id))) {
        emitStreamPullResponse(
          socket,
          {
            success: false,
            error: {
              code: "TOO_MANY_REQUESTS",
              message: "Too many agent stream pulls, please try again later.",
              statusCode: 429,
            },
          },
          { ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}) },
        );
        return;
      }
      commandQuotaConsumed = true;

      assertNotAborted();
      const prepared = prepareLegacyAgentStreamPull({
        consumerSocketId: socket.id,
        ...(parsed.data.streamId ? { streamId: parsed.data.streamId } : {}),
        ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
        ...(parsed.data.windowSize !== undefined ? { windowSize: parsed.data.windowSize } : {}),
      });
      assertNotAborted();

      const agentId = resolveStreamRouteAgentId({
        streamId: prepared.streamId,
        requestId: prepared.requestId,
      });
      if (!agentId) {
        // Missing/expired stream is not client abuse — catch refunds shared agents:command quota.
        throw new AppError("Stream route not found", { code: "NOT_FOUND", statusCode: 404 });
      }

      await assertConsumerSocketAgentAccess(socket.data.user, agentId, socket);
      assertNotAborted();
      const allowance = await allowAgentsStreamPullCredits(userSub, socket.id, prepared.windowSize);
      if (!allowance.allowed) {
        emitStreamPullResponse(
          socket,
          {
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
          },
          { ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}) },
        );
        return;
      }
      grantedCredits = allowance.grantedCredits;
      const result = prepared.execute();

      emitStreamPullResponse(
        socket,
        {
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
        },
        { requestId: result.requestId },
      );
    } catch (err: unknown) {
      if (grantedCredits > 0) {
        try {
          await refundAgentsStreamPullCredits(userSub, socket.id, grantedCredits);
        } catch (refundError: unknown) {
          logger.warn("agents_stream_pull_credit_refund_failed", {
            socketId: socket.id,
            userSub,
            grantedCredits,
            message: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
      }
      const appError = err instanceof AppError ? err : undefined;
      // Refund shared command quota on transient/server faults after consume.
      // Keep quota on client authz faults (401/403) and other 4xx except 404
      // (404 already refunded above when stream route is missing).
      if (
        commandQuotaConsumed &&
        (appError === undefined ||
          appError.statusCode === undefined ||
          appError.statusCode >= 500 ||
          appError.statusCode === 404)
      ) {
        try {
          await refundAgentsCommandSocketAsync(userSub, socket.id);
        } catch (refundError: unknown) {
          logger.warn("agents_stream_pull_command_quota_refund_failed", {
            socketId: socket.id,
            userSub,
            reason: appError?.code ?? "STREAM_PULL_FAILED",
            message: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
      }
      const code = appError?.code ?? "STREAM_PULL_FAILED";
      const message = err instanceof Error ? err.message : "Failed to pull stream";
      const statusCode = appError?.statusCode;
      const retryAfterMs = resolveAppErrorRetryAfterMs(err);
      if (retryAfterMs !== undefined) {
        noteSocketErrorRetryAfterMsPropagated();
      }

      emitStreamPullResponse(
        socket,
        {
          success: false,
          error: {
            code,
            message,
            ...(typeof statusCode === "number" ? { statusCode } : {}),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        },
        { ...(correlationRequestId !== undefined ? { requestId: correlationRequestId } : {}) },
      );
    } finally {
      unregisterAbortController();
      releaseSocketInflightSlot(socket);
    }
  })();
};
