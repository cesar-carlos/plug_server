import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/presentation/socket/hub/rpc_bridge", () => ({
  requestRelayStreamPull: vi.fn(),
}));

vi.mock("../../src/presentation/socket/hub/consumer_relay_rate_limiter", () => ({
  allowRelayStreamPull: vi.fn(),
}));

import { handleRelayRpcStreamPull } from "../../src/presentation/socket/consumers/relay_rpc_stream_pull.handler";
import {
  buildConnectionReadyPayloadForWire,
  CONNECTION_READY_LEGACY_COMPAT_REMOVE_AFTER,
} from "../../src/presentation/socket/hub/connection_ready_handshake";
import { requestRelayStreamPull } from "../../src/presentation/socket/hub/rpc_bridge";
import { allowRelayStreamPull } from "../../src/presentation/socket/hub/consumer_relay_rate_limiter";
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

  it("returns RATE_LIMITED stream pull responses with remaining credit metadata", async () => {
    vi.mocked(requestRelayStreamPull).mockReturnValue({
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 64,
    });
    vi.mocked(allowRelayStreamPull).mockReturnValue({
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
      data: { user: { sub: "user-1", role: "user" } },
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    } as const;

    handleRelayRpcStreamPull(socket as never, {
      conversationId: "conv-1",
      frame: { schemaVersion: "1.0" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(emitted).toHaveLength(1);
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
  });
});
