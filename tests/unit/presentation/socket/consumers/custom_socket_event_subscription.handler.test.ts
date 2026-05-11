import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { socketEvents } from "../../../../../src/shared/constants/socket_events";

vi.mock("../../../../../src/presentation/socket/hub/custom_socket_event_subscription_limiter", () => ({
  allowCustomSocketEventSubscriptionControl: vi.fn(() => ({
    allowed: true,
    limit: 240,
    remaining: 239,
    resetAtMs: Date.now() + 60_000,
  })),
}));

vi.mock("../../../../../src/presentation/socket/hub/custom_socket_event_subscription_registry", () => ({
  addCustomSocketEventSubscription: vi.fn(() => true),
  hasCustomSocketEventSubscription: vi.fn(() => false),
  countCustomSocketEventSubscriptionsBySocketId: vi.fn(() => 0),
  removeCustomSocketEventSubscription: vi.fn(() => true),
}));

vi.mock("../../../../../src/shared/metrics/socket_consumer.metrics", () => ({
  noteCustomSocketEventSubscriptionForbidden: vi.fn(),
  noteCustomSocketEventSubscriptionRejected: vi.fn(),
  noteCustomSocketEventSubscribed: vi.fn(),
  noteCustomSocketEventUnsubscribed: vi.fn(),
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

const mockedAllow = vi.mocked(allowCustomSocketEventSubscriptionControl);
const mockedNoteRejected = vi.mocked(noteCustomSocketEventSubscriptionRejected);
const mockedNoteForbidden = vi.mocked(noteCustomSocketEventSubscriptionForbidden);
const mockedAdd = vi.mocked(addCustomSocketEventSubscription);
const mockedRemove = vi.mocked(removeCustomSocketEventSubscription);

const buildSocket = (principalType: "client" | "user"): Socket => {
  const join = vi.fn().mockResolvedValue(undefined);
  const leave = vi.fn().mockResolvedValue(undefined);
  return {
    id: "sock-sub-1",
    data: {
      user:
        principalType === "client"
          ? { principal_type: "client" as const, sub: "client-sub-1", role: "client" }
          : { principal_type: "user" as const, sub: "user-sub-1", role: "user" },
    },
    emit: vi.fn(),
    join,
    leave,
  } as unknown as Socket;
};

describe("custom_socket_event_subscription.handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects subscribe for non-client principals before rate limit", () => {
    const socket = buildSocket("user");
    handleCustomSocketEventSubscribe(socket, {
      requestId: "r1",
      eventName: "client:custom.x",
    });

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

  it("rejects unsubscribe for non-client principals before rate limit", () => {
    const socket = buildSocket("user");
    handleCustomSocketEventUnsubscribe(socket, {
      requestId: "r2",
      eventName: "client:custom.x",
    });

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

    expect(mockedAllow).toHaveBeenCalled();
    await Promise.resolve();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: true,
        requestId: "r3",
        data: { eventName: "client:custom.ok", subscribed: true },
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
    await Promise.resolve();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventSubscribed,
      expect.objectContaining({
        success: true,
        data: { eventName: "client:custom.dup", subscribed: true, alreadySubscribed: true },
      }),
    );
  });

  it("includes wasSubscribed on unsubscribe ack from registry removal", async () => {
    mockedRemove.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const socket = buildSocket("client");
    handleCustomSocketEventUnsubscribe(socket, {
      requestId: "u1",
      eventName: "client:custom.leave",
    });
    await Promise.resolve();
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
    await Promise.resolve();
    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.socketEventUnsubscribed,
      expect.objectContaining({
        success: true,
        data: { eventName: "client:custom.leave", subscribed: false, wasSubscribed: false },
      }),
    );
  });
});