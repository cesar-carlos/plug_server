import type { Socket } from "socket.io";

import { env } from "../../../shared/config/env";
import { socketEvents } from "../../../shared/constants/socket_events";
import {
  noteCustomSocketEventSubscriptionForbidden,
  noteCustomSocketEventSubscriptionRejected,
  noteCustomSocketEventSubscribed,
  noteCustomSocketEventUnsubscribed,
} from "../../../shared/metrics/socket_consumer.metrics";
import {
  extractSocketEventRequestId,
  socketEventSubscriptionSchema,
} from "../../../shared/validators/custom_socket_event";
import { buildCustomSocketEventRoom } from "../hub/custom_events/custom_socket_event_rooms";
import { allowCustomSocketEventSubscriptionControl } from "../hub/rate_limits/custom_socket_event_subscription_limiter";
import {
  addCustomSocketEventSubscription,
  countCustomSocketEventSubscriptionsBySocketId,
  hasCustomSocketEventSubscription,
  removeCustomSocketEventSubscription,
} from "../hub/custom_events/custom_socket_event_subscription_registry";
import {
  assertActiveClientCustomSocketEventPrincipal,
  disconnectSocketAfterCustomSocketEventAuthFailure,
  handleCustomSocketEventAuthFailure,
  isNonClientCustomSocketEventPrincipalError,
  isTerminalCustomSocketEventAuthFailure,
} from "./custom_socket_event_guard";

type SubscriptionResponse =
  | {
      readonly success: true;
      readonly requestId: string;
      readonly data: {
        readonly eventName: string;
        readonly subscribed: boolean;
        readonly alreadySubscribed?: boolean;
        readonly wasSubscribed?: boolean;
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

  const requestId = extractSocketEventRequestId(rawPayload);
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
  if (!socket.connected) {
    return;
  }
  socket.emit(eventName, payload);
};

const emitCustomSocketEventSubscriptionAuthFailure = (
  socket: Socket,
  responseEventName: string,
  requestId: string,
  error: unknown,
  forbiddenMessage: string,
): void => {
  const appError = handleCustomSocketEventAuthFailure(error);
  if (isNonClientCustomSocketEventPrincipalError(appError)) {
    noteCustomSocketEventSubscriptionForbidden();
  } else {
    noteCustomSocketEventSubscriptionRejected();
  }
  emitSubscriptionResponse(socket, responseEventName, {
    success: false,
    requestId,
    error: {
      code: isNonClientCustomSocketEventPrincipalError(appError) ? "FORBIDDEN" : appError.code,
      message: isNonClientCustomSocketEventPrincipalError(appError)
        ? forbiddenMessage
        : appError.message,
      ...(appError.statusCode !== undefined ? { statusCode: appError.statusCode } : {}),
    },
  });
  if (isTerminalCustomSocketEventAuthFailure(appError)) {
    disconnectSocketAfterCustomSocketEventAuthFailure(socket, appError);
  }
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

  void (async (): Promise<void> => {
    try {
      await assertActiveClientCustomSocketEventPrincipal(socket);
    } catch (error: unknown) {
      emitCustomSocketEventSubscriptionAuthFailure(
        socket,
        socketEvents.socketEventSubscribed,
        requestId,
        error,
        "Only Client principals may subscribe to custom socket events",
      );
      return;
    }

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

    try {
      await Promise.resolve(socket.join(buildCustomSocketEventRoom(eventName)));
    } catch (error: unknown) {
      noteCustomSocketEventSubscriptionRejected();
      emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
        success: false,
        requestId,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error ? error.message : "Failed to join custom socket event room",
        },
      });
      return;
    }
    const addedNew = addCustomSocketEventSubscription(socket.id, eventName);
    if (addedNew) {
      noteCustomSocketEventSubscribed();
    }
    emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
      success: true,
      requestId,
      data: {
        eventName,
        subscribed: true,
        ...(addedNew ? {} : { alreadySubscribed: true as const }),
      },
    });
  })().catch((error: unknown) => {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventSubscribed, {
      success: false,
      requestId,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : "Unexpected subscribe error",
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

  void (async (): Promise<void> => {
    try {
      await assertActiveClientCustomSocketEventPrincipal(socket);
    } catch (error: unknown) {
      emitCustomSocketEventSubscriptionAuthFailure(
        socket,
        socketEvents.socketEventUnsubscribed,
        requestId,
        error,
        "Only Client principals may unsubscribe from custom socket events",
      );
      return;
    }

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

    try {
      await Promise.resolve(socket.leave(buildCustomSocketEventRoom(eventName)));
    } catch (error: unknown) {
      noteCustomSocketEventSubscriptionRejected();
      emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
        success: false,
        requestId,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error ? error.message : "Failed to leave custom socket event room",
        },
      });
      return;
    }
    const wasSubscribed = removeCustomSocketEventSubscription(socket.id, eventName);
    if (wasSubscribed) {
      noteCustomSocketEventUnsubscribed();
    }
    emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
      success: true,
      requestId,
      data: { eventName, subscribed: false, wasSubscribed },
    });
  })().catch((error: unknown) => {
    noteCustomSocketEventSubscriptionRejected();
    emitSubscriptionResponse(socket, socketEvents.socketEventUnsubscribed, {
      success: false,
      requestId,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : "Unexpected unsubscribe error",
      },
    });
  });
};
