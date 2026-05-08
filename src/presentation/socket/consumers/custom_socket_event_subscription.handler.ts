import type { Socket } from "socket.io";

import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  noteCustomSocketEventSubscriptionRejected,
  noteCustomSocketEventSubscribed,
  noteCustomSocketEventUnsubscribed,
} from "../../../shared/metrics/socket_consumer.metrics";
import { socketEventSubscriptionSchema } from "../../../shared/validators/custom_socket_event";
import { buildCustomSocketEventRoom } from "../hub/custom_socket_event_rooms";
import { allowCustomSocketEventSubscriptionControl } from "../hub/custom_socket_event_subscription_limiter";
import {
  addCustomSocketEventSubscription,
  countCustomSocketEventSubscriptionsBySocketId,
  hasCustomSocketEventSubscription,
  removeCustomSocketEventSubscription,
} from "../hub/custom_socket_event_subscription_registry";

type SubscriptionResponse =
  | {
      readonly success: true;
      readonly requestId: string;
      readonly data: { readonly eventName: string; readonly subscribed: boolean };
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

const parseSubscriptionPayload = (
  rawPayload: unknown,
):
  | {
      readonly ok: true;
      readonly value: { readonly requestId: string; readonly eventName: string };
    }
  | {
      readonly ok: false;
      readonly requestId?: string;
      readonly message: string;
    } => {
  const parsed = socketEventSubscriptionSchema.safeParse(rawPayload);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const requestId =
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    typeof (rawPayload as Record<string, unknown>).requestId === "string"
      ? String((rawPayload as Record<string, unknown>).requestId)
      : undefined;
  const firstIssue = parsed.error.issues[0];
  return {
    ok: false,
    ...(requestId !== undefined ? { requestId } : {}),
    message: firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed",
  };
};

const emitSubscriptionResponse = (
  socket: Socket,
  eventName: string,
  payload: SubscriptionResponse,
): void => {
  socket.emit(eventName, payload);
};

export const handleCustomSocketEventSubscribe = (socket: Socket, rawPayload: unknown): void => {
  const parsed = parseSubscriptionPayload(rawPayload);
  if (!parsed.ok) {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
      success: false,
      ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}),
      error: { code: "VALIDATION_ERROR", message: parsed.message },
    });
    return;
  }

  const { eventName, requestId } = parsed.value;
  const allowance = allowCustomSocketEventSubscriptionControl(socket.id);
  if (!allowance.allowed) {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
      success: false,
      requestId,
      error: {
        code: "RATE_LIMITED",
        message: "Rate limit exceeded for socket:event.subscribe",
        statusCode: 429,
        ...(allowance.retryAfterMs !== undefined ? { retryAfterMs: allowance.retryAfterMs } : {}),
      },
      rateLimit: {
        limit: allowance.limit,
        remaining: allowance.remaining,
        resetAtMs: allowance.resetAtMs,
      },
    });
    return;
  }

  const isAlreadySubscribed = hasCustomSocketEventSubscription(socket.id, eventName);
  if (
    !isAlreadySubscribed &&
    env.socketCustomEventMaxSubscriptionsPerSocket > 0 &&
    countCustomSocketEventSubscriptionsBySocketId(socket.id) >=
      env.socketCustomEventMaxSubscriptionsPerSocket
  ) {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
      success: false,
      requestId,
      error: {
        code: "SUBSCRIPTION_LIMIT_EXCEEDED",
        message: "Custom socket event subscription limit exceeded for this socket",
        statusCode: 429,
      },
    });
    return;
  }

  void Promise.resolve(socket.join(buildCustomSocketEventRoom(eventName)))
    .then(() => {
      if (addCustomSocketEventSubscription(socket.id, eventName)) {
        noteCustomSocketEventSubscribed();
      }
      emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
        success: true,
        requestId,
        data: { eventName, subscribed: true },
      });
    })
    .catch((error: unknown) => {
      noteCustomSocketEventSubscriptionRejected();
      emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
        success: false,
        requestId,
        error: {
          code: "SUBSCRIBE_FAILED",
          message: error instanceof Error ? error.message : "Failed to subscribe to event",
        },
      });
    });
};

export const handleCustomSocketEventUnsubscribe = (socket: Socket, rawPayload: unknown): void => {
  const parsed = parseSubscriptionPayload(rawPayload);
  if (!parsed.ok) {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
      success: false,
      ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}),
      error: { code: "VALIDATION_ERROR", message: parsed.message },
    });
    return;
  }

  const { eventName, requestId } = parsed.value;
  const allowance = allowCustomSocketEventSubscriptionControl(socket.id);
  if (!allowance.allowed) {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
      success: false,
      requestId,
      error: {
        code: "RATE_LIMITED",
        message: "Rate limit exceeded for socket:event.unsubscribe",
        statusCode: 429,
        ...(allowance.retryAfterMs !== undefined ? { retryAfterMs: allowance.retryAfterMs } : {}),
      },
      rateLimit: {
        limit: allowance.limit,
        remaining: allowance.remaining,
        resetAtMs: allowance.resetAtMs,
      },
    });
    return;
  }

  void Promise.resolve(socket.leave(buildCustomSocketEventRoom(eventName)))
    .then(() => {
      if (removeCustomSocketEventSubscription(socket.id, eventName)) {
        noteCustomSocketEventUnsubscribed();
      }
      emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
        success: true,
        requestId,
        data: { eventName, subscribed: false },
      });
    })
    .catch((error: unknown) => {
      noteCustomSocketEventSubscriptionRejected();
      emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
        success: false,
        requestId,
        error: {
          code: "UNSUBSCRIBE_FAILED",
          message: error instanceof Error ? error.message : "Failed to unsubscribe from event",
        },
      });
    });
};
