import type { Socket } from "socket.io";
import { z } from "zod";

import { createBridgeLatencyTraceForRequest } from "../../../application/services/bridge_latency_trace_builder";
import { recordSocketAuditEvent } from "../../../application/services/socket_audit.service";
import { dispatchRelayRpcToAgent } from "../hub/relay/rpc_bridge";
import { AppError } from "../../../shared/errors/app_error";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { conversationIdSchema } from "../../../shared/validators/schemas";
import { payloadFrameCompressionSchema } from "../../../shared/validators/agent_command";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import { isRecord } from "../../../shared/utils/rpc_types";
import { conversationRegistry } from "../hub/registries/conversation_registry";
import { refundRelayRpcRequestAsync } from "../hub/rate_limits/consumer_relay_rate_limiter";
import { assertConsumerSocketAgentAccess, resolveSocketActorRole } from "./consumer_socket_guard";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "./per_socket_inflight_gate";
import { resolveAppErrorRetryAfterMs } from "./socket_retry_after";
import {
  noteRelayFastPathFallbackDedup,
  noteRelayFastPathFallbackError,
  noteRelayFastPathForbidden,
  noteRelayFastPathHonored,
  noteRelayFastPathRequested,
  noteServerTimingsOptIn,
  noteSocketErrorRetryAfterMsPropagated,
} from "../../../shared/metrics/socket_consumer.metrics";

/**
 * Rate-limit refund policy for `relay:rpc.request` after quota was consumed:
 * - **Refund**: non-`AppError` (unexpected / transient), marked `400` from deep
 *   PayloadFrame/JSON-RPC validation, and `AppError` outside the 4xx range (e.g. 503).
 * - **No refund**: authorization/routing/conflict/rate-limit 4xx
 *   (`401`, `403`, `404`, `409`, `429`, etc.).
 *
 * Envelope `VALIDATION_ERROR` is rejected before quota consumption in `socket.ts`.
 * Idempotent dedupe (`deduplicated: true`) refunds on the success path separately.
 */
export const shouldRefundRelayRpcRequestRateLimit = (error: unknown): boolean => {
  if (!(error instanceof AppError)) {
    return true;
  }
  if (error.statusCode === 400) {
    return isRecord(error.details) && error.details.refundRelayRpcRequestRateLimit === true;
  }
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }
  return true;
};

export const relayRpcEnvelopeSchema = z.object({
  conversationId: conversationIdSchema,
  frame: z.unknown(),
  payloadFrameCompression: payloadFrameCompressionSchema.optional(),
  /**
   * Opt-in for `meta.serverTimings` on `relay:rpc.response`. When `true`, the
   * hub attaches the per-phase latency snapshot collected for this request to
   * the agent's response payload before encoding the outbound PayloadFrame. See
   * `docs/socket_relay_protocol.md` ("Server-side phase diagnostics").
   *
   * The cost is roughly ~120 bytes per response so the flag is opt-in to avoid
   * inflating high-throughput streaming consumers that do not consume timings.
   */
  requestServerTimings: z.boolean().optional(),
  /**
   * Opt-in for the relay unary fast-path. When `true`, the hub skips emitting
   * `relay:rpc.accepted` for this request and the consumer only sees
   * `relay:rpc.response` (or stream events). Dedup state (`deduplicated` /
   * `replayed` / `inFlight`) is still signalled via `relay:rpc.accepted` when
   * the request was deduplicated, because in that case the response frame
   * cannot carry the new request's state. See `docs/socket_relay_protocol.md`
   * ("Relay unary fast-path").
   *
   * Streaming-capable methods (e.g. `sql.execute` with `prefer_db_streaming`
   * or `multi_result`, `sql.executeBatch`) SHOULD NOT set this flag: the
   * window/credit handshake requires `relay:rpc.accepted` to anchor
   * `requestId` before `relay:rpc.stream.pull`. The hub does not reject those
   * methods on the request, but consumers that set the flag for streaming
   * RPCs may not be able to issue further `stream.pull` until the first
   * chunk arrives.
   */
  fastPath: z.boolean().optional(),
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
  | {
      success: false;
      error: { code: string; message: string; statusCode?: number; retryAfterMs?: number };
    };

const emitRelayRpcAccepted = (socket: Socket, payload: RelayRpcAcceptedPayload): void => {
  if (socket.connected === false) {
    return;
  }
  socket.emit(socketEvents.relayRpcAccepted, payload);
};

export const parseRelayRpcRequestEnvelope = (
  rawPayload: unknown,
): { success: true; data: RelayRpcRequestEnvelope } | { success: false; errorMessage: string } => {
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
  envelope: RelayRpcRequestEnvelope,
): void => {
  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;

  if (!tryAcquireSocketInflightSlot(socket, env.socketConsumerMaxInflightPerSocket)) {
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
  // Track adoption for the relay opt-ins before any dispatch path can
  // short-circuit. Outcome counters (honored / fallback) are incremented
  // later once `dispatchRelayRpcToAgent` resolves.
  // `SOCKET_RELAY_FAST_PATH_FORBIDDEN` is a deployment-level kill switch
  // for environments that mandate the legacy 3-event flow (audit /
  // compliance). When set, we strip the `fastPath` opt-in here so the rest
  // of the pipeline behaves as if the consumer never asked for it. Counter
  // `fastPathForbiddenTotal` makes the gate observable in Prometheus.
  const effectiveFastPath =
    envelope.fastPath === true && !env.socketRelayFastPathForbidden;
  if (envelope.fastPath === true) {
    noteRelayFastPathRequested();
    if (!effectiveFastPath) {
      noteRelayFastPathForbidden();
    }
  }
  if (envelope.requestServerTimings === true) {
    noteServerTimingsOptIn("relay");
  }
  // Force-active the trace when the consumer opted into `meta.serverTimings`,
  // even if the global sampling toggle is off; otherwise fall back to the
  // sampled factory so production cost is unchanged for opt-out consumers.
  const latencyTrace = createBridgeLatencyTraceForRequest({
    channel: "relay",
    userId: userSub,
    forceActive: envelope.requestServerTimings === true,
  });
  const abortController = new AbortController();
  const unregisterAbortController = registerConsumerCommandAbortController(
    socket.id,
    abortController,
  );

  void (async () => {
    try {
      const conversation = conversationRegistry.findInternalByConversationId(
        envelope.conversationId,
      );
      if (!conversation || conversation.consumerSocketId !== socket.id) {
        throw new AppError("Conversation not found", { code: "NOT_FOUND", statusCode: 404 });
      }

      await assertConsumerSocketAgentAccess(socket.data.user, conversation.agentId, socket);

      const result = await dispatchRelayRpcToAgent({
        conversationId: envelope.conversationId,
        consumerSocketId: socket.id,
        rawFramePayload: envelope.frame,
        ...(envelope.payloadFrameCompression !== undefined
          ? { payloadFrameCompression: envelope.payloadFrameCompression }
          : {}),
        ...(latencyTrace ? { latencyTrace } : {}),
        signal: abortController.signal,
        ...(envelope.requestServerTimings === true ? { requestServerTimings: true } : {}),
        ...(effectiveFastPath ? { fastPath: true } : {}),
      });

      // Fast-path: when the consumer opted in AND the request was not
      // deduplicated, skip `relay:rpc.accepted` entirely. Deduplicated requests
      // still emit `accepted` because the response frame cannot carry the new
      // request's dedup state — keeping `accepted` on this edge preserves
      // diagnostics while still saving the hop on the common path.
      const isDedup =
        result.deduplicated === true || result.replayed === true || result.inFlight === true;
      const skipAccepted = result.fastPath === true && !isDedup;

      if (result.fastPath === true) {
        if (skipAccepted) {
          noteRelayFastPathHonored();
        } else if (isDedup) {
          noteRelayFastPathFallbackDedup();
        }
      }

      if (!skipAccepted) {
        emitRelayRpcAccepted(socket, {
          success: true,
          conversationId: envelope.conversationId,
          requestId: result.requestId,
          ...(result.clientRequestId ? { clientRequestId: result.clientRequestId } : {}),
          ...(result.deduplicated ? { deduplicated: true } : {}),
          ...(result.replayed ? { replayed: true } : {}),
          ...(result.inFlight ? { inFlight: true } : {}),
        });
      }
      if (result.deduplicated) {
        await refundRelayRpcRequestAsync(userSub, socket.id);
      }

      const actorRole = resolveSocketActorRole(socket.data.user);
      void recordSocketAuditEvent({
        eventType: socketEvents.relayRpcRequest,
        actorSocketId: socket.id,
        actorUserId: socket.data.user?.sub ?? null,
        ...(actorRole ? { actorRole } : {}),
        direction: "consumer_to_agent",
        conversationId: envelope.conversationId,
        requestId: result.requestId,
        payload: {
          clientRequestId: result.clientRequestId ?? null,
          deduplicated: result.deduplicated === true,
          replayed: result.replayed === true,
          inFlight: result.inFlight === true,
          // Opt-in adoption signals so post-mortems can distinguish "consumer
          // did not receive accepted because the hub honored fast-path" from
          // "consumer did not receive accepted because of a bug".
          fastPathRequested: envelope.fastPath === true,
          fastPathHonored: result.fastPath === true && !(result.deduplicated === true),
          serverTimingsRequested: envelope.requestServerTimings === true,
        },
      });
    } catch (err: unknown) {
      const appError = err instanceof AppError ? err : undefined;
      if (effectiveFastPath) {
        // Even when the dispatcher rejected the request before honoring
        // fast-path, the consumer relies on `relay:rpc.accepted { success: false }`
        // for the error — track that to spot pathological fast-path usage.
        // The forbidden-by-deployment path is tracked separately above to
        // keep this counter scoped to true fast-path errors.
        noteRelayFastPathFallbackError();
      }
      if (shouldRefundRelayRpcRequestRateLimit(err)) {
        await refundRelayRpcRequestAsync(userSub, socket.id);
      }
      const retryAfterMs = resolveAppErrorRetryAfterMs(err);
      if (retryAfterMs !== undefined) {
        noteSocketErrorRetryAfterMsPropagated();
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
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      });
    } finally {
      unregisterAbortController();
      releaseSocketInflightSlot(socket);
    }
  })();
};
