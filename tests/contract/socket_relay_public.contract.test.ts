import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/presentation/socket/hub/relay/rpc_bridge", () => ({
  prepareRelayStreamPull: vi.fn(),
}));

vi.mock("../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter", () => ({
  allowRelayStreamPullAsync: vi.fn(),
}));

vi.mock("../../src/presentation/socket/hub/registries/conversation_registry", () => ({
  conversationRegistry: {
    findInternalByConversationId: vi.fn(() => ({
      consumerSocketId: "consumer-1",
      agentId: "agent-1",
    })),
  },
}));

vi.mock("../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn().mockResolvedValue({ type: "user", id: "user-1" }),
  resolveSocketActorRole: vi.fn(() => "user"),
}));

import { handleRelayRpcStreamPull } from "../../src/presentation/socket/consumers/relay_rpc_stream_pull.handler";
import {
  buildConnectionReadyPayloadForWire,
  CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER,
} from "../../src/presentation/socket/hub/handshake/connection_ready_handshake";
import { prepareRelayStreamPull } from "../../src/presentation/socket/hub/relay/rpc_bridge";
import { allowRelayStreamPullAsync } from "../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { decodePayloadFrame, isPayloadFrameEnvelope } from "../../src/shared/utils/payload_frame";

describe("socket relay public contract", () => {
  it("encodes `connection:ready` as PayloadFrame by default", () => {
    expect(CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const wire = buildConnectionReadyPayloadForWire({
      id: "socket-123",
      message: "ready",
      user: null,
    });

    expect(isPayloadFrameEnvelope(wire)).toBe(true);
    const decoded = decodePayloadFrame(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.data).toEqual({
        id: "socket-123",
        message: "ready",
        user: null,
      });
    }
  });

  it("returns RATE_LIMITED stream pull responses with remaining credit metadata without executing the pull", async () => {
    const execute = vi.fn();
    vi.mocked(prepareRelayStreamPull).mockResolvedValue({
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 64,
      execute,
    });
    vi.mocked(allowRelayStreamPullAsync).mockResolvedValue({
      allowed: false,
      scope: "user",
      limit: 1000,
      requestedCredits: 64,
      grantedCredits: 0,
      remainingCredits: 12,
    });

    const emitted: Array<{ event: string; payload: unknown }> = [];
    const socket = {
      id: "consumer-1",
      connected: true,
      data: { user: { sub: "user-1", role: "user" } },
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    } as const;

    handleRelayRpcStreamPull(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.event).toBe(socketEvents.relayRpcStreamPullResponse);
    expect(emitted[0]?.payload).toEqual({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Stream pull credit budget exceeded for this window",
        statusCode: 429,
      },
      rateLimit: {
        remainingCredits: 12,
        limit: 1000,
        scope: "user",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
