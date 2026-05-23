import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { socketEvents } from "../../../../../src/shared/constants/socket_events";

vi.mock(
  "../../../../../src/presentation/socket/hub/custom_socket_event_subscription_limiter",
  () => ({
    allowCustomSocketEventSubscriptionControl: vi.fn(() => ({
      allowed: true,
      limit: 240,
      remaining: 239,
      resetAtMs: Date.now() + 60_000,
    })),
  }),
);

vi.mock(
  "../../../../../src/presentation/socket/hub/custom_socket_event_subscription_registry",
  () => ({
    addCustomSocketEventSubscription: vi.fn(() => true),
    hasCustomSocketEventSubscription: vi.fn(() => false),
    countCustomSocketEventSubscriptionsBySocketId: vi.fn(() => 0),
    removeCustomSocketEventSubscription: vi.fn(() => true),
  }),
);

vi.mock("../../../../../src/shared/metrics/socket_consumer.metrics", () => ({
  noteCustomSocketEventSubscriptionForbidden: vi.fn(),
  noteCustomSocketEventSubscriptionRejected: vi.fn(),
  noteCustomSocketEventSubscribed: vi.fn(),
  noteCustomSocketEventUnsubscribed: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/custom_socket_event_guard", () => ({
  assertActiveClientCustomSocketEventPrincipal: vi.fn(async (socket: Socket) => {
    const user = (socket as { data?: { user?: { sub?: string } } }).data?.user;
    if (!user?.sub) {
      throw new Error("missing sub");
    }
    if (user.sub.startsWith("user-")) {
      throw new Error("Only Client principals may use custom socket events");
    }
    return user.sub;
  }),
  handleCustomSocketEventAuthFailure: vi.fn((error: unknown) => {
    if (
      error instanceof Error &&
      error.message === "Only Client principals may use custom socket events"
    ) {
      return { code: "FORBIDDEN", message: error.message, statusCode: 403 };
    }
    return { code: "UNAUTHORIZED", message: "Authentication required", statusCode: 401 };
  }),
  isTerminalCustomSocketEventAuthFailure: vi.fn(() => true),
  isNonClientCustomSocketEventPrincipalError: vi.fn(
    (error: { code?: string; message?: string }) =>
      error.code === "FORBIDDEN" &&
      error.message === "Only Client principals may use custom socket events",
  ),
  disconnectSocketAfterCustomSocketEventAuthFailure: vi.fn(),
}));

import { allowCustomSocketEventSubscriptionControl } from "../../../../../src/presentation/socket/hub/custom_socket_event_subscription_limiter";
import {
  handleCustomSocketEventSubscribe,
  handleCustomSocketEventUnsubscribe,
} from "../../../../../src/presentation/socket/consumers/custom_socket_event_subscription.handler";
import {
  addCustomSocketEventSubscription,
  removeCustomSocketEventSubscription,
} from "../../../../../src/presentation/socket/hub/custom_socket_event_subscription_registry";
import {
  noteCustomSocketEventSubscriptionForbidden,
  noteCustomSocketEventSubscriptionRejected,
} from "../../../../../src/shared/metrics/socket_consumer.metrics";
import { disconnectSocketAfterCustomSocketEventAuthFailure } from "../../../../../src/presentation/socket/consumers/custom_socket_event_guard";

const mockedAllow = vi.mocked(allowCustomSocketEventSubscriptionControl);
const mockedNoteRejected = vi.mocked(noteCustomSocketEventSubscriptionRejected);
const mockedNoteForbidden = vi.mocked(noteCustomSocketEventSubscriptionForbidden);
const mockedAdd = vi.mocked(addCustomSocketEventSubscription);
const mockedRemove = vi.mocked(removeCustomSocketEventSubscription);
const mockedDisconnect = vi.mocked(disconnectSocketAfterCustomSocketEventAuthFailure);

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const buildSocket = (principalType: "client" | "user"): Socket => {
  const join = vi.fn().mockResolvedValue(undefined);
  const leave = vi.fn().mockResolvedValue(undefined);
  return {
    id: "sock-sub-1",
    connected: true,
    data: {
      user:
        principalType === "client"
          ? { principal_type: "client" as const, sub: "client-sub-1", role: "client" }
          : { principal_type: "user" as const, sub: "user-sub-1", role: "user" },
    },
    emit: vi.fn(),
    join,
    leave,
    disconnect: vi.fn(),
  } as unknown as Socket;
};

describe("custom_socket_event_subscription.handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects subscribe for non-client principals before rate limit", async () => {
    const socket = buildSocket("user");
    handleCustomSocketEventSubscribe(socket, {
      requestId: "r1",
      eventName: "client:custom.x",
    });

    await flushMicrotasks();
    expect(mockedAllow).not.toHaveBeenCalled();
    expect(mockedNoteForbidden).toHaveBeenCalledTimes(1);
    expect(mockedNoteRejected).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: false,
        requestId: "r1",
        error: expect.objectContaining({
          code: "FORBIDDEN",
          statusCode: 403,
        }),
      }),
    );
  });

  it("rejects unsubscribe for non-client principals before rate limit", async () => {
    const socket = buildSocket("user");
    handleCustomSocketEventUnsubscribe(socket, {
      requestId: "r2",
      eventName: "client:custom.x",
    });

    await flushMicrotasks();
    expect(mockedAllow).not.toHaveBeenCalled();
    expect(mockedNoteForbidden).toHaveBeenCalledTimes(1);
    expect(mockedNoteRejected).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventUnsubscribed,
      expect.objectContaining({
        success: false,
        requestId: "r2",
        error: expect.objectContaining({
          code: "FORBIDDEN",
          statusCode: 403,
        }),
      }),
    );
  });

  it("allows subscribe for client principals", async () => {
    const socket = buildSocket("client");
    handleCustomSocketEventSubscribe(socket, {
      requestId: "r3",
      eventName: "client:custom.ok",
    });

    await flushMicrotasks();
    expect(mockedAllow).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: true,
        requestId: "r3",
        data: { eventName: "client:custom.ok", subscribed: true },
      }),
    );
  });

  it("should reject subscribe when rate limit is exceeded", async () => {
    mockedAllow.mockReturnValueOnce({
      allowed: false,
      limit: 240,
      remaining: 0,
      resetAtMs: Date.now() + 60_000,
      retryAfterMs: 5_000,
    });
    const socket = buildSocket("client");

    handleCustomSocketEventSubscribe(socket, {
      requestId: "r-rate",
      eventName: "client:custom.rate",
    });

    await flushMicrotasks();
    expect(mockedNoteRejected).toHaveBeenCalledTimes(1);
    expect(mockedAdd).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: false,
        requestId: "r-rate",
        error: expect.objectContaining({
          code: "RATE_LIMITED",
          message: "Rate limit exceeded for socket:event.subscribe",
          statusCode: 429,
          retryAfterMs: 5_000,
        }),
        rateLimit: expect.objectContaining({
          limit: 240,
          remaining: 0,
        }),
      }),
    );
  });

  it("includes alreadySubscribed when join succeeds but registry already had the event", async () => {
    mockedAdd.mockReturnValue(false);
    const socket = buildSocket("client");
    handleCustomSocketEventSubscribe(socket, {
      requestId: "r-dup",
      eventName: "client:custom.dup",
    });
    await flushMicrotasks();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: true,
        data: { eventName: "client:custom.dup", subscribed: true, alreadySubscribed: true },
      }),
    );
  });

  it("should emit INTERNAL_SERVER_ERROR and not disconnect when room join fails", async () => {
    const socket = buildSocket("client");
    (socket.join as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("join failed"));

    handleCustomSocketEventSubscribe(socket, {
      requestId: "r-join-fail",
      eventName: "client:custom.join-fail",
    });

    await flushMicrotasks();

    expect(mockedDisconnect).not.toHaveBeenCalled();
    expect(mockedNoteRejected).toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: false,
        requestId: "r-join-fail",
        error: expect.objectContaining({ code: "INTERNAL_SERVER_ERROR", message: "join failed" }),
      }),
    );
  });

  it("should not emit subscribe ack when socket is disconnected", async () => {
    const socket = buildSocket("client");
    handleCustomSocketEventSubscribe(socket, {
      requestId: "r-disconnected",
      eventName: "client:custom.offline",
    });
    (socket as { connected: boolean }).connected = false;
    await flushMicrotasks();

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("includes wasSubscribed on unsubscribe ack from registry removal", async () => {
    mockedRemove.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const socket = buildSocket("client");
    handleCustomSocketEventUnsubscribe(socket, {
      requestId: "u1",
      eventName: "client:custom.leave",
    });
    await flushMicrotasks();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventUnsubscribed,
      expect.objectContaining({
        success: true,
        data: { eventName: "client:custom.leave", subscribed: false, wasSubscribed: true },
      }),
    );

    handleCustomSocketEventUnsubscribe(socket, {
      requestId: "u2",
      eventName: "client:custom.leave",
    });
    await flushMicrotasks();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventUnsubscribed,
      expect.objectContaining({
        success: true,
        data: { eventName: "client:custom.leave", subscribed: false, wasSubscribed: false },
      }),
    );
  });
});
