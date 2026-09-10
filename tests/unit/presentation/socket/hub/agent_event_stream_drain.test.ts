import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ack: vi.fn(),
  active: vi.fn(),
  commitCursor: vi.fn(),
  getCursor: vi.fn(),
  hasSubscription: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../../../../../src/infrastructure/redis/event_stream/agent_event_stream", () => ({
  ackAgentEventFrames: mocks.ack,
  isAgentEventStreamActive: mocks.active,
  readAgentEventBacklog: mocks.read,
}));

vi.mock("../../../../../src/infrastructure/redis/event_stream/agent_event_stream_cursor", () => ({
  commitAgentEventCursor: mocks.commitCursor,
  getAgentEventCursor: mocks.getCursor,
}));

vi.mock(
  "../../../../../src/presentation/socket/hub/custom_events/custom_socket_event_subscription_registry",
  () => ({ hasCustomSocketEventSubscription: mocks.hasSubscription }),
);

vi.mock("../../../../../src/shared/config/env", () => ({
  env: { agentEventStreamDrainAckTimeoutMs: 100 },
}));

import { drainAgentEventBacklogForSubscription } from "../../../../../src/presentation/socket/hub/agent_event_stream_drain";

const createSocket = (): {
  readonly connected: boolean;
  readonly emit: ReturnType<typeof vi.fn>;
  readonly id: string;
} => ({
  connected: true,
  emit: vi.fn((_eventName: string, _payload: string, ack: () => void) => ack()),
  id: "socket-1",
});

describe("drainAgentEventBacklogForSubscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.active.mockReturnValue(true);
    mocks.getCursor.mockResolvedValue("0-0");
    mocks.hasSubscription.mockReturnValue(true);
    mocks.ack.mockResolvedValue(undefined);
    mocks.commitCursor.mockResolvedValue(undefined);
  });

  it("uses the event-specific stream and cursor without filtering another subscription", async () => {
    const socket = createSocket();
    mocks.read.mockResolvedValue([
      {
        streamId: "10-0",
        eventId: "event-alpha",
        eventName: "client:custom.alpha",
        emittedAt: "2026-01-01T00:00:00.000Z",
        payload: '{"n":1}',
      },
    ]);

    await drainAgentEventBacklogForSubscription({
      socket: socket as never,
      principalId: "principal-1",
      eventName: "client:custom.alpha",
    });

    expect(mocks.getCursor).toHaveBeenCalledWith("principal-1", "client:custom.alpha");
    expect(mocks.read).toHaveBeenCalledWith("principal-1", "client:custom.alpha", "0-0");
    expect(socket.emit).toHaveBeenCalledWith(
      "client:custom.alpha",
      '{"n":1}',
      expect.any(Function),
    );
    expect(mocks.commitCursor).toHaveBeenCalledWith("principal-1", "client:custom.alpha", "10-0");
    expect(mocks.ack).toHaveBeenCalledWith("principal-1", "client:custom.alpha", ["10-0"]);
  });

  it("stops delivering when a concurrent unsubscribe removes the subscription", async () => {
    const socket = createSocket();
    mocks.read.mockResolvedValue([
      {
        streamId: "10-0",
        eventId: "event-1",
        eventName: "client:custom.alpha",
        emittedAt: "2026-01-01T00:00:00.000Z",
        payload: '{"n":1}',
      },
      {
        streamId: "11-0",
        eventId: "event-2",
        eventName: "client:custom.alpha",
        emittedAt: "2026-01-01T00:00:01.000Z",
        payload: '{"n":2}',
      },
    ]);
    mocks.hasSubscription.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await drainAgentEventBacklogForSubscription({
      socket: socket as never,
      principalId: "principal-1",
      eventName: "client:custom.alpha",
    });

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(mocks.commitCursor).toHaveBeenCalledTimes(1);
    expect(mocks.ack).toHaveBeenCalledWith("principal-1", "client:custom.alpha", ["10-0"]);
  });
});
