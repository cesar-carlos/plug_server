import type { Socket } from "socket.io";

import {
  assertClientSocketEventPublishInputWithinLimits,
  executeClientSocketEventPublish,
} from "../../../application/services/client_socket_event_publish.service";
import {
  allowClientSocketEventPublishSocketAsync,
  refundClientSocketEventPublishSocketAsync,
} from "../hub/client_socket_event_publish_socket_rate_limiter";
import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import { AppError } from "../../../shared/errors/app_error";
import {
  noteCustomSocketEventPublishRejected,
  noteCustomSocketEventPublishViaSocket,
} from "../../../shared/metrics/socket_consumer.metrics";
import {
  jsonUtf8ByteLengthOrNull,
  socketEventPublishRequestSchema,
  toClientSocketEventPublishInput,
} from "../../../shared/validators/custom_socket_event";
import {
  releaseCustomPublishInflightSlot,
  releaseSocketInflightSlot,
  tryAcquireCustomPublishInflightSlot,
  tryAcquireSocketInflightSlot,
  type SocketWithCustomPublishInflight,
  type SocketWithInflightCounter,
} from "./per_socket_inflight_gate";
import { resolveAppErrorRetryAfterMs } from "./socket_retry_after";

type PublishedAck =
  | {
      readonly success: true;
      readonly requestId: string;
      readonly data: {
        readonly eventId: string;
        readonly eventName: string;
        readonly recipients: number;
        readonly idempotencyKey?: string;
        readonly idempotentReplay: boolean;
      };
    }
  | {
      readonly success: false;
      readonly requestId?: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly statusCode?: number;
        readonly retryAfterMs?: number;
      };
      readonly rateLimit?: {
        readonly limit: number;
        readonly remaining: number;
        readonly resetAtMs: number;
      };
    };

/** Avoids writing to a disconnected Engine.IO client (e.g. publish completed after `disconnect`). */
const emitPublishedIfConnected = (socket: Socket, payload: PublishedAck): void => {
  if (!socket.connected) {
    return;
  }
  socket.emit(socketEvents.socketEventPublished, payload);
};

const extractRequestId = (raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const rid = (raw as Record<string, unknown>).requestId;
  return typeof rid === "string" && rid.trim() !== "" ? rid.trim() : undefined;
};

/**
 * After `allowClientSocketEventPublishSocketAsync` consumes a slot, refund on execute failure
 * except for client idempotency conflicts (quota should not be refunded for abusive mismatched retries).
 * Exported for unit tests.
 */
export const shouldRefundSocketCustomEventPublishRateLimit = (error: unknown): boolean => {
  if (!(error instanceof AppError)) {
    return true;
  }
  if (error.code === "IDEMPOTENCY_KEY_CONFLICT" || error.statusCode === 409) {
    return false;
  }
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }
  return true;
};

export const handleCustomSocketEventPublish = (socket: Socket, rawPayload: unknown): void => {
  const requestIdFallback = extractRequestId(rawPayload);

  const rawBytes = jsonUtf8ByteLengthOrNull(rawPayload);
  if (rawBytes === null || rawBytes > env.socketEventPublishRawJsonMaxBytes) {
    noteCustomSocketEventPublishRejected();
    emitPublishedIfConnected(socket, {
      success: false,
      ...(requestIdFallback !== undefined ? { requestId: requestIdFallback } : {}),
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "socket:event.publish JSON envelope exceeds raw size limit",
        statusCode: 413,
      },
    });
    return;
  }

  const parsed = socketEventPublishRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    noteCustomSocketEventPublishRejected();
    const firstIssue = parsed.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";
    emitPublishedIfConnected(socket, {
      success: false,
      ...(requestIdFallback !== undefined ? { requestId: requestIdFallback } : {}),
      error: { code: "VALIDATION_ERROR", message },
    });
    return;
  }

  const { requestId, idempotencyKey } = parsed.data;
  const user = socket.data.user;

  if (user?.principal_type !== "client" || typeof user.sub !== "string" || user.sub.trim() === "") {
    noteCustomSocketEventPublishRejected();
    emitPublishedIfConnected(socket, {
      success: false,
      requestId,
      error: {
        code: "FORBIDDEN",
        message: "Only Client principals may publish custom socket events",
        statusCode: 403,
      },
    });
    return;
  }

  const clientSub = user.sub.trim();
  const publishInflightMax = env.socketCustomEventPublishMaxInflightPerSocket;
  const useDedicatedPublishInflight = publishInflightMax > 0;
  const inflightSocket = socket as SocketWithInflightCounter & SocketWithCustomPublishInflight;

  const acquiredInflight = useDedicatedPublishInflight
    ? tryAcquireCustomPublishInflightSlot(inflightSocket, publishInflightMax)
    : tryAcquireSocketInflightSlot(inflightSocket, env.socketConsumerMaxInflightPerSocket);

  if (!acquiredInflight) {
    noteCustomSocketEventPublishRejected();
    emitPublishedIfConnected(socket, {
      success: false,
      requestId,
      error: {
        code: "RATE_LIMITED",
        message: useDedicatedPublishInflight
          ? "Custom publish concurrent limit exceeded"
          : "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
    return;
  }

  void (async (): Promise<void> => {
    try {
      const body = toClientSocketEventPublishInput(parsed.data);
      try {
        assertClientSocketEventPublishInputWithinLimits(body);
      } catch (error: unknown) {
        noteCustomSocketEventPublishRejected();
        if (error instanceof AppError) {
          emitPublishedIfConnected(socket, {
            success: false,
            requestId,
            error: {
              code: error.code,
              message: error.message,
              statusCode: error.statusCode,
            },
          });
          return;
        }
        emitPublishedIfConnected(socket, {
          success: false,
          requestId,
          error: { code: "VALIDATION_ERROR", message: "Invalid socket event publish request" },
        });
        return;
      }

      const allowed = await allowClientSocketEventPublishSocketAsync(clientSub);
      if (!allowed) {
        noteCustomSocketEventPublishRejected();
        emitPublishedIfConnected(socket, {
          success: false,
          requestId,
          error: {
            code: "RATE_LIMITED",
            message: "Too many socket event publish requests, please try again later.",
            statusCode: 429,
            retryAfterMs: env.socketCustomEventPublishRateLimitWindowMs,
          },
          rateLimit: {
            limit: env.socketCustomEventPublishRateLimitMax,
            remaining: 0,
            resetAtMs: Date.now() + env.socketCustomEventPublishRateLimitWindowMs,
          },
        });
        return;
      }

      try {
        const outcome = await executeClientSocketEventPublish({
          clientId: clientSub,
          body,
          publishRequestId: requestId,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        });
        if (!outcome.idempotentReplay) {
          noteCustomSocketEventPublishViaSocket();
        }
        emitPublishedIfConnected(socket, {
          success: true,
          requestId,
          data: {
            eventId: outcome.eventId,
            eventName: outcome.eventName,
            recipients: outcome.recipients,
            ...(outcome.idempotencyKey !== undefined
              ? { idempotencyKey: outcome.idempotencyKey, idempotentReplay: outcome.idempotentReplay }
              : { idempotentReplay: outcome.idempotentReplay }),
          },
        });
      } catch (error: unknown) {
        noteCustomSocketEventPublishRejected();
        if (shouldRefundSocketCustomEventPublishRateLimit(error)) {
          await refundClientSocketEventPublishSocketAsync(clientSub, 1);
        }
        if (error instanceof AppError) {
          const retryAfterMs = resolveAppErrorRetryAfterMs(error);
          emitPublishedIfConnected(socket, {
            success: false,
            requestId,
            error: {
              code: error.code,
              message: error.message,
              statusCode: error.statusCode,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            },
          });
          return;
        }
        emitPublishedIfConnected(socket, {
          success: false,
          requestId,
          error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected error publishing event" },
        });
      }
    } finally {
      if (useDedicatedPublishInflight) {
        releaseCustomPublishInflightSlot(inflightSocket);
      } else {
        releaseSocketInflightSlot(inflightSocket);
      }
    }
  })().catch(() => {
    noteCustomSocketEventPublishRejected();
    emitPublishedIfConnected(socket, {
      success: false,
      requestId,
      error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected error publishing event" },
    });
  });
};
