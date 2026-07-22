/**
 * Socket handler for `relay:rpc.request.batch` — the consumer-facing batch
 * variant of `relay:rpc.request`. See `docs/adrs/0008-relay-batch-protocol.md`
 * for the contract decisions and `docs/socket_relay_protocol.md` for the
 * wire-level documentation.
 *
 * v1 scope:
 * - Accept 1..`SOCKET_RELAY_BATCH_MAX_ITEMS` items per envelope.
 * - Reject if `SOCKET_RELAY_BATCH_ENABLED=false` (default).
 * - Acquire per-socket inflight slots **all-or-nothing**; partial accept is
 *   rejected as a contract complexity that buys nothing.
 * - Dispatch items concurrently via `dispatchRelayRpcToAgent`, each as if it
 *   were a single-RPC request. Per-item responses arrive on the existing
 *   `relay:rpc.response`.
 * - Emit a single `relay:rpc.batch_accepted` carrying the per-item
 *   `clientRequestId → requestId` correlation plus dedup state.
 * - Reject streaming-capable items at validation (`sql.execute` with
 *   `prefer_db_streaming` or `multi_result`, `sql.executeBatch`).
 *
 * v2: `requestServerTimings` and `fastPath` on the envelope propagate to
 * per-item dispatch (mirrors `relay:rpc.request`). ADR Decision B still
 * applies: always emit `relay:rpc.batch_accepted`; never per-item
 * `relay:rpc.accepted`.
 */

import type { Socket } from "socket.io";
import { z } from "zod";

import { createBridgeLatencyTraceForRequest } from "../../../application/services/bridge_latency_trace_builder";
import { dispatchRelayRpcToAgent } from "../hub/relay/rpc_bridge";
import { conversationRegistry } from "../hub/registries/conversation_registry";
import {
  allowRelayRpcRequestAsync,
  refundRelayRpcRequestAsync,
} from "../hub/rate_limits/consumer_relay_rate_limiter";
import { AppError } from "../../../shared/errors/app_error";
import { badRequest } from "../../../shared/errors/http_errors";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { conversationIdSchema } from "../../../shared/validators/schemas";
import {
  AGENT_TIMEOUT_MS_LIMIT,
  bridgeSingleCommandSchema,
  payloadFrameCompressionSchema,
} from "../../../shared/validators/agent_command";
import { decodePayloadFrameAsync } from "../../../shared/utils/payload_frame";
import { isRecord, toRequestId } from "../../../shared/utils/rpc_types";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";
import {
  releaseSocketInflightSlots,
  tryAcquireSocketInflightSlots,
} from "./per_socket_inflight_gate";
import { assertConsumerSocketAgentAccess } from "./consumer_socket_guard";
import { shouldRefundRelayRpcRequestRateLimit } from "./relay_rpc_request.handler";
import { registerConsumerCommandAbortController } from "./consumer_command_abort_registry";
import {
  noteRelayBatchAccepted,
  noteRelayBatchEnvelopeReceived,
  noteRelayBatchRejected,
  noteRelayFastPathForbidden,
  noteRelayFastPathRequested,
  observeRelayBatchEnvelopeDecodeMs,
  observeRelayBatchItemsPerEnvelope,
  noteServerTimingsOptIn,
} from "../../../shared/metrics/socket_consumer.metrics";

export const relayRpcRequestBatchEnvelopeSchema = z.object({
  conversationId: conversationIdSchema,
  frame: z.unknown(),
  payloadFrameCompression: payloadFrameCompressionSchema.optional(),
  requestServerTimings: z.boolean().optional(),
  fastPath: z.boolean().optional(),
  /** Per-item hub wait; propagates to each `dispatchRelayRpcToAgent` (REST `timeoutMs` parity). */
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(AGENT_TIMEOUT_MS_LIMIT + 60_000)
    .optional(),
});

export type RelayRpcRequestBatchEnvelope = z.infer<typeof relayRpcRequestBatchEnvelopeSchema>;

export const parseRelayRpcRequestBatchEnvelope = (
  rawPayload: unknown,
):
  | { success: true; data: RelayRpcRequestBatchEnvelope }
  | { success: false; errorMessage: string } => {
  const parsed = relayRpcRequestBatchEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    return { success: false, errorMessage: message };
  }
  return { success: true, data: parsed.data };
};

type RelayRpcBatchAcceptedItem =
  | {
      clientRequestId: string;
      requestId: string;
      deduplicated?: boolean;
      replayed?: boolean;
      inFlight?: boolean;
    }
  | {
      clientRequestId: string | null;
      error: { code: string; message: string; statusCode?: number; itemIndex: number };
    };

type RelayRpcBatchAcceptedPayload =
  | {
      success: true;
      conversationId: string;
      batchSize: number;
      items: RelayRpcBatchAcceptedItem[];
    }
  | {
      success: false;
      conversationId?: string;
      error: {
        code: string;
        message: string;
        statusCode?: number;
        details?: Record<string, unknown>;
      };
    };

const emitBatchAccepted = (socket: Socket, payload: RelayRpcBatchAcceptedPayload): void => {
  if (socket.connected === false) {
    return;
  }
  socket.emit(socketEvents.relayRpcBatchAccepted, payload);
};

const STREAMING_CAPABLE_METHODS = new Set(["sql.executeBatch"]);

interface ParsedBatchItem {
  readonly clientRequestId: string;
  readonly command: z.infer<typeof bridgeSingleCommandSchema>;
}

interface BatchValidationOk {
  readonly ok: true;
  readonly items: readonly ParsedBatchItem[];
}

interface BatchValidationError {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly statusCode?: number;
    readonly details?: Record<string, unknown>;
  };
}

const validateBatchItems = (
  rawArray: readonly unknown[],
): BatchValidationOk | BatchValidationError => {
  if (rawArray.length === 0) {
    return {
      ok: false,
      error: {
        code: "BATCH_EMPTY",
        message: "relay:rpc.request.batch must include at least one item",
        statusCode: 400,
      },
    };
  }
  if (rawArray.length > env.socketRelayBatchMaxItems) {
    return {
      ok: false,
      error: {
        code: "BATCH_TOO_LARGE",
        message: `relay:rpc.request.batch cannot exceed ${env.socketRelayBatchMaxItems} items`,
        statusCode: 400,
        details: { maxItems: env.socketRelayBatchMaxItems, receivedItems: rawArray.length },
      },
    };
  }

  const items: ParsedBatchItem[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < rawArray.length; index += 1) {
    const raw = rawArray[index];
    const parsed = bridgeSingleCommandSchema.safeParse(raw);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = firstIssue
        ? `items[${index}].${firstIssue.path.join(".")}: ${firstIssue.message}`
        : `items[${index}]: invalid JSON-RPC command`;
      return {
        ok: false,
        error: {
          code: "BATCH_ITEM_INVALID",
          message,
          statusCode: 400,
          details: { itemIndex: index },
        },
      };
    }
    const command = parsed.data;
    const clientRequestId = toRequestId(command.id);
    if (!clientRequestId) {
      return {
        ok: false,
        error: {
          code: "BATCH_ITEM_REQUIRES_ID",
          message: `items[${index}]: each batch item must declare a JSON-RPC id (notifications not supported in v1)`,
          statusCode: 400,
          details: { itemIndex: index },
        },
      };
    }
    if (seenIds.has(clientRequestId)) {
      return {
        ok: false,
        error: {
          code: "BATCH_DUPLICATE_ID",
          message: `items[${index}]: duplicate JSON-RPC id "${clientRequestId}" within batch`,
          statusCode: 400,
          details: { itemIndex: index, id: clientRequestId },
        },
      };
    }
    seenIds.add(clientRequestId);

    if (STREAMING_CAPABLE_METHODS.has(command.method)) {
      return {
        ok: false,
        error: {
          code: "BATCH_STREAMING_ITEM_REJECTED",
          message: `items[${index}].method: streaming-capable method "${command.method}" is not allowed inside a batch (v1 restriction)`,
          statusCode: 400,
          details: { itemIndex: index, method: command.method },
        },
      };
    }
    if (
      command.method === "sql.execute" &&
      (command.params.options?.prefer_db_streaming === true ||
        command.params.options?.multi_result === true)
    ) {
      return {
        ok: false,
        error: {
          code: "BATCH_STREAMING_ITEM_REJECTED",
          message: `items[${index}].params.options: sql.execute with prefer_db_streaming or multi_result is not allowed inside a batch (v1 restriction)`,
          statusCode: 400,
          details: { itemIndex: index, method: command.method },
        },
      };
    }

    items.push({ clientRequestId, command });
  }

  return { ok: true, items };
};

export const handleRelayRpcRequestBatch = (
  socket: Socket & { data: { user?: JwtAccessPayload } },
  envelope: RelayRpcRequestBatchEnvelope,
): void => {
  const userSub = typeof socket.data.user?.sub === "string" ? socket.data.user.sub : undefined;
  noteRelayBatchEnvelopeReceived();

  if (!env.socketRelayBatchEnabled) {
    noteRelayBatchRejected("disabled");
    emitBatchAccepted(socket, {
      success: false,
      conversationId: envelope.conversationId,
      error: {
        code: "RELAY_BATCH_DISABLED",
        message:
          "relay:rpc.request.batch is disabled on this hub (set SOCKET_RELAY_BATCH_ENABLED=true to enable)",
        statusCode: 503,
      },
    });
    return;
  }

  const abortController = new AbortController();
  const unregisterAbortController = registerConsumerCommandAbortController(
    socket.id,
    abortController,
  );

  void (async (): Promise<void> => {
    let rateLimitCost = 0;
    try {
      const conversation = conversationRegistry.findInternalByConversationId(
        envelope.conversationId,
      );
      if (!conversation || conversation.consumerSocketId !== socket.id) {
        noteRelayBatchRejected("not_found");
        emitBatchAccepted(socket, {
          success: false,
          conversationId: envelope.conversationId,
          error: {
            code: "NOT_FOUND",
            message: "Conversation not found",
            statusCode: 404,
          },
        });
        return;
      }

      await assertConsumerSocketAgentAccess(socket.data.user, conversation.agentId, socket);

      // Decode the batch frame ONCE. Each item is dispatched via preDecodedData.
      const batchDecodeStart = performance.now();
      const decoded = await decodePayloadFrameAsync(envelope.frame);
      observeRelayBatchEnvelopeDecodeMs(performance.now() - batchDecodeStart);
      if (!decoded.ok) {
        noteRelayBatchRejected("frame_decode_failed");
        emitBatchAccepted(socket, {
          success: false,
          conversationId: envelope.conversationId,
          error: {
            code: "BAD_REQUEST",
            message: decoded.error.message,
            statusCode: 400,
          },
        });
        return;
      }

      const data = decoded.value.data;
      if (!Array.isArray(data)) {
        noteRelayBatchRejected("not_array");
        emitBatchAccepted(socket, {
          success: false,
          conversationId: envelope.conversationId,
          error: {
            code: "BAD_REQUEST",
            message:
              "relay:rpc.request.batch frame.data must be a JSON-RPC array (use relay:rpc.request for single items)",
            statusCode: 400,
          },
        });
        return;
      }

      const validation = validateBatchItems(data);
      if (!validation.ok) {
        noteRelayBatchRejected("validation_failed");
        emitBatchAccepted(socket, { success: false, conversationId: envelope.conversationId, error: validation.error });
        return;
      }
      const items = validation.items;

      if (!(await allowRelayRpcRequestAsync(userSub, socket.id, items.length))) {
        noteRelayBatchRejected("rate_limited");
        emitBatchAccepted(socket, {
          success: false,
          conversationId: envelope.conversationId,
          error: {
            code: "RATE_LIMITED",
            message: "Rate limit exceeded for relay:rpc.request.batch",
            statusCode: 429,
          },
        });
        return;
      }
      rateLimitCost = items.length;

      const effectiveFastPath = envelope.fastPath === true && !env.socketRelayFastPathForbidden;
      if (envelope.fastPath === true) {
        noteRelayFastPathRequested();
        if (!effectiveFastPath) {
          noteRelayFastPathForbidden();
        }
      }
      if (envelope.requestServerTimings === true) {
        noteServerTimingsOptIn("relay");
      }

      // Decision C in ADR 0008: all-or-nothing inflight gate accounting.
      const acquire = tryAcquireSocketInflightSlots(
        socket,
        items.length,
        env.socketConsumerMaxInflightPerSocket,
      );
      if (!acquire.ok) {
        noteRelayBatchRejected("inflight_gate");
        await refundRelayRpcRequestAsync(userSub, socket.id, rateLimitCost);
        rateLimitCost = 0;
        emitBatchAccepted(socket, {
          success: false,
          conversationId: envelope.conversationId,
          error: {
            code: "RATE_LIMITED",
            message: "Per-socket inflight gate cannot accommodate the full batch",
            statusCode: 429,
            details: {
              availableSlots: acquire.availableSlots,
              requestedSlots: acquire.requestedSlots,
            },
          },
        });
        return;
      }

      try {
        // Concurrent dispatch — items targeting the same agent will serialize
        // inside the per-agent dispatch queue (`SOCKET_RELAY_AGENT_MAX_INFLIGHT`).
        const settledResults = await Promise.allSettled(
          items.map(async (item) => {
            const latencyTrace = createBridgeLatencyTraceForRequest({
              channel: "relay",
              userId: userSub,
              forceActive: envelope.requestServerTimings === true,
            });
            try {
              const dispatched = await dispatchRelayRpcToAgent({
                conversationId: envelope.conversationId,
                consumerSocketId: socket.id,
                preDecodedData: item.command,
                ...(envelope.payloadFrameCompression !== undefined
                  ? { payloadFrameCompression: envelope.payloadFrameCompression }
                  : {}),
                ...(envelope.requestServerTimings === true ? { requestServerTimings: true } : {}),
                ...(effectiveFastPath ? { fastPath: true } : {}),
                ...(envelope.timeoutMs !== undefined ? { timeoutMs: envelope.timeoutMs } : {}),
                ...(latencyTrace !== null ? { latencyTrace } : {}),
                signal: abortController.signal,
              });
              return { item, dispatched };
            } catch (dispatchErr: unknown) {
              const appError = dispatchErr instanceof AppError ? dispatchErr : undefined;
              if (latencyTrace && !latencyTrace.isFinalized()) {
                if (latencyTrace.hasDispatchMeta()) {
                  latencyTrace.finalizeOnce({
                    outcome: "error",
                    ...(typeof appError?.statusCode === "number"
                      ? { httpStatus: appError.statusCode }
                      : {}),
                    errorCode: appError?.code ?? "BATCH_ITEM_DISPATCH_FAILED",
                  });
                } else {
                  latencyTrace.dismissWithoutPersist();
                }
              }
              throw dispatchErr;
            }
          }),
        );

        const ackedItems: RelayRpcBatchAcceptedItem[] = settledResults.map((settled, index) => {
          const item = items[index]!;
          if (settled.status === "fulfilled") {
            const { dispatched } = settled.value;
            return {
              clientRequestId: item.clientRequestId,
              requestId: dispatched.requestId,
              ...(dispatched.deduplicated ? { deduplicated: true } : {}),
              ...(dispatched.replayed ? { replayed: true } : {}),
              ...(dispatched.inFlight ? { inFlight: true } : {}),
            };
          }
          const reason: unknown = settled.reason;
          const appError = reason instanceof AppError ? reason : undefined;
          return {
            clientRequestId: item.clientRequestId,
            error: {
              code: appError?.code ?? "BATCH_ITEM_DISPATCH_FAILED",
              message: reason instanceof Error ? reason.message : "Failed to dispatch batch item",
              ...(typeof appError?.statusCode === "number"
                ? { statusCode: appError.statusCode }
                : {}),
              itemIndex: index,
            },
          };
        });

        const dedupedCount = ackedItems.filter(
          (entry) => "deduplicated" in entry && entry.deduplicated === true,
        ).length;
        const refundableErrorCount = settledResults.reduce((count, settled) => {
          if (settled.status !== "rejected") {
            return count;
          }
          return shouldRefundRelayRpcRequestRateLimit(settled.reason) ? count + 1 : count;
        }, 0);
        const errorCount = ackedItems.filter((entry) => "error" in entry).length;
        noteRelayBatchAccepted({
          itemCount: items.length,
          dedupedCount,
          errorCount,
        });
        observeRelayBatchItemsPerEnvelope(items.length);

        // Refund per-item rate limit budget for deduplicated items and for
        // dispatch failures that the single-RPC path would also refund
        // (`shouldRefundRelayRpcRequestRateLimit`). Single batched refund
        // instead of N awaited Redis round-trips.
        const refundCount = dedupedCount + refundableErrorCount;
        if (refundCount > 0) {
          await refundRelayRpcRequestAsync(userSub, socket.id, refundCount);
        }

        emitBatchAccepted(socket, {
          success: true,
          conversationId: envelope.conversationId,
          batchSize: items.length,
          items: ackedItems,
        });
      } finally {
        releaseSocketInflightSlots(socket, items.length);
      }
    } catch (err: unknown) {
      const appError = err instanceof AppError ? err : undefined;
      if (rateLimitCost > 0 && shouldRefundRelayRpcRequestRateLimit(err)) {
        await refundRelayRpcRequestAsync(userSub, socket.id, rateLimitCost);
        rateLimitCost = 0;
      }
      noteRelayBatchRejected("envelope_error");
      emitBatchAccepted(socket, {
        success: false,
        conversationId: envelope.conversationId,
        error: {
          code: appError?.code ?? "RELAY_BATCH_REQUEST_FAILED",
          message: err instanceof Error ? err.message : "Failed to relay batch request",
          ...(typeof appError?.statusCode === "number" ? { statusCode: appError.statusCode } : {}),
        },
      });
    } finally {
      unregisterAbortController();
    }
  })();
};

// Re-export the local helpers for unit testing.
export const __testing = {
  validateBatchItems,
  isRecord,
  badRequest,
};
