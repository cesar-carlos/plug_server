import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/application/services/socket_audit.service", () => ({
  recordSocketAuditEvent: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/relay/rpc_bridge", () => ({
  prepareRelayStreamPull: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter", () => ({
  allowRelayStreamPullAsync: vi.fn(),
  refundRelayStreamPullCreditsAsync: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/registries/conversation_registry", () => ({
  conversationRegistry: {
    findInternalByConversationId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
  resolveSocketActorRole: vi.fn(() => "user"),
}));

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

import { prepareRelayStreamPull } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge";
import { allowRelayStreamPullAsync } from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import { conversationRegistry } from "../../../../../src/presentation/socket/hub/registries/conversation_registry";
import { handleRelayRpcStreamPull } from "../../../../../src/presentation/socket/consumers/relay_rpc_stream_pull.handler";
import { abortPendingConsumerCommands } from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

const mockedPrepareRelayStreamPull = vi.mocked(prepareRelayStreamPull);
const mockedAllowRelayStreamPull = vi.mocked(allowRelayStreamPullAsync);
const mockedFindConversation = vi.mocked(conversationRegistry.findInternalByConversationId);
const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);
const mockedReleaseInflight = vi.mocked(releaseSocketInflightSlot);

const buildSocket = () =>
  ({
    id: "consumer-1",
    connected: true,
    data: {
      user: {
        sub: "user-1",
        principal_type: "user",
        role: "user",
      },
    },
    emit: vi.fn(),
  }) as const;

describe("handleRelayRpcStreamPull", () => {
  beforeEach(() => {
    mockedPrepareRelayStreamPull.mockReset();
    mockedAllowRelayStreamPull.mockReset();
    mockedFindConversation.mockReset();
    mockedAssertAccess.mockReset();
    mockedTryAcquire.mockReset();
    mockedReleaseInflight.mockReset();
    mockedTryAcquire.mockReturnValue(true);

    mockedFindConversation.mockReturnValue({
      conversationId: "conv-1",
      consumerSocketId: "consumer-1",
      agentId: "agent-1",
      agentSocketId: "agent-socket-1",
      createdAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
    });
    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
    mockedPrepareRelayStreamPull.mockResolvedValue({
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 16,
      execute: vi.fn(() => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 16,
      })),
    });
    mockedAllowRelayStreamPull.mockResolvedValue({
      allowed: true,
      scope: "user",
      limit: 100,
      requestedCredits: 16,
      grantedCredits: 16,
      remainingCredits: 84,
    });
  });

  it("returns RATE_LIMITED when the per-socket inflight gate is full", () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = buildSocket();

    handleRelayRpcStreamPull(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    expect(mockedPrepareRelayStreamPull).not.toHaveBeenCalled();
    expect(mockedAllowRelayStreamPull).not.toHaveBeenCalled();
    expect(mockedReleaseInflight).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayRpcStreamPullResponse, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
  });

  it("does not grant credits or pull if the consumer disconnects while access is checked", async () => {
    const socket = buildSocket();
    let resolveAccess!: () => void;
    mockedAssertAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccess = () => resolve({ type: "user", id: "user-1", role: "user" });
        }),
    );

    handleRelayRpcStreamPull(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => expect(mockedAssertAccess).toHaveBeenCalled());
    expect(abortPendingConsumerCommands("consumer-1")).toBe(1);
    resolveAccess();

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(socketEvents.relayRpcStreamPullResponse, {
        success: false,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Consumer socket disconnected before stream pull completed",
          statusCode: 503,
        },
      });
    });
    expect(mockedPrepareRelayStreamPull).not.toHaveBeenCalled();
    expect(mockedAllowRelayStreamPull).not.toHaveBeenCalled();
  });
});
