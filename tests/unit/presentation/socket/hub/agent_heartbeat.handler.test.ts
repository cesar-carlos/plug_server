import type * as PayloadFrameModule from "../../../../../src/shared/utils/payload_frame";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../../src/shared/utils/payload_frame", async (importOriginal) => {
  const actual = await importOriginal<typeof PayloadFrameModule>();
  return { ...actual, decodePayloadFrameAsync: vi.fn(actual.decodePayloadFrameAsync) };
});
vi.mock("../../../../../src/application/services/agent_hub_presence_sync", () => ({
  runAgentHubPresenceSyncSafely: vi.fn(),
  syncAgentHubPresenceOnTouch: vi.fn(),
}));
vi.mock(
  "../../../../../src/presentation/socket/hub/rate_limits/agent_heartbeat_socket_rate_limiter",
  () => ({ allowAgentHeartbeatSocketEvent: vi.fn(() => true) }),
);
import {
  handleAgentHeartbeat,
  cleanupAgentHeartbeatState,
} from "../../../../../src/presentation/socket/hub/handlers/agent_heartbeat.handler";
import type { AgentHubSocket } from "../../../../../src/presentation/socket/hub/handlers/_shared";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { allowAgentHeartbeatSocketEvent } from "../../../../../src/presentation/socket/hub/rate_limits/agent_heartbeat_socket_rate_limiter";
import {
  decodePayloadFrame,
  decodePayloadFrameAsync,
  encodePayloadFrame,
} from "../../../../../src/shared/utils/payload_frame";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

const buildSocket = (): AgentHubSocket =>
  ({
    id: "heartbeat-socket",
    connected: true,
    data: { agentId: "heartbeat-agent" },
    emit: vi.fn(),
    disconnect: vi.fn(),
  }) as unknown as AgentHubSocket;
const register = (socket: AgentHubSocket, capabilities: Record<string, unknown> = {}): void => {
  agentRegistry.upsert({
    agentId: socket.data.agentId!,
    socketId: socket.id,
    userId: null,
    capabilities,
  });
};
const frame = (id: string, gzip = false): ReturnType<typeof encodePayloadFrame> =>
  encodePayloadFrame(
    {
      agent_id: "heartbeat-agent",
      trace_id: id,
      ...(gzip
        ? {
            padding: Array.from({ length: 130 }, (_, n) =>
              createHash("sha256").update(String(n)).digest("hex"),
            ).join(""),
          }
        : {}),
    },
    { requestId: id },
  );
const asyncDecoder = vi.mocked(decodePayloadFrameAsync);

describe("heartbeat lifecycle and ordered decoding", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof PayloadFrameModule>(
      "../../../../../src/shared/utils/payload_frame",
    );
    asyncDecoder.mockImplementation(actual.decodePayloadFrameAsync);
    vi.mocked(allowAgentHeartbeatSocketEvent).mockReturnValue(true);
  });
  afterEach(() => {
    agentRegistry.clear();
  });

  it("commits uncompressed frames synchronously with correlated ACK", () => {
    const socket = buildSocket();
    register(socket);
    expect(handleAgentHeartbeat(socket, frame("sync"))).toBeUndefined();
    expect(asyncDecoder).not.toHaveBeenCalled();
    const ack = decodePayloadFrame(vi.mocked(socket.emit).mock.calls[0]![1]);
    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.value.frame.requestId).toBe("sync");
      expect(ack.value.data).toMatchObject({
        agent_id: "heartbeat-agent",
        status: "ok",
        trace_id: "sync",
      });
    }
  });

  it("decodes gzip via the async API and orders subsequent mixed frames", async () => {
    const socket = buildSocket();
    register(socket);
    const compressed = frame("first", true);
    expect(compressed.cmp).toBe("gzip");
    let finish!: () => void;
    asyncDecoder.mockImplementationOnce(async (raw) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return decodePayloadFrame(raw);
    });
    const first = handleAgentHeartbeat(socket, compressed);
    const second = handleAgentHeartbeat(socket, frame("second"));
    await Promise.resolve();
    expect(socket.emit).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(asyncDecoder).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(socket.emit).mock.calls.map((call) => {
        const decoded = decodePayloadFrame(call[1]);
        return decoded.ok ? decoded.value.frame.requestId : null;
      }),
    ).toEqual(["first", "second"]);
  });

  it.each(["disconnect", "replace", "identity"])(
    "does not touch presence after %s during decode",
    async (change) => {
      const socket = buildSocket();
      register(socket);
      const touch = vi.spyOn(agentRegistry, "touchLiveness");
      let finish!: () => void;
      asyncDecoder.mockImplementationOnce(async (raw) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return decodePayloadFrame(raw);
      });
      const pending = handleAgentHeartbeat(socket, frame("old", true));
      await Promise.resolve();
      if (change === "disconnect") {
        socket.connected = false;
        cleanupAgentHeartbeatState(socket);
      } else if (change === "replace") {
        agentRegistry.upsert({
          agentId: "heartbeat-agent",
          socketId: "replacement",
          userId: null,
          capabilities: {},
        });
      } else socket.data.agentId = "other-agent";
      finish();
      await pending;
      expect(touch).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(socket.emit)
          .mock.calls.filter((call) => call[0] === socketEvents.hubHeartbeatAck),
      ).toHaveLength(0);
      touch.mockRestore();
    },
  );

  it("applies rate limit before either decoder", async () => {
    const socket = buildSocket();
    register(socket);
    vi.mocked(allowAgentHeartbeatSocketEvent).mockReturnValue(false);
    await handleAgentHeartbeat(socket, frame("limited", true));
    expect(asyncDecoder).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("preserves explicit readiness and rejects invalid signatures without touching liveness", async () => {
    const socket = buildSocket();
    register(socket, { extensions: { protocolReadyAck: true } });
    await handleAgentHeartbeat(socket, frame("ready", true));
    expect(agentRegistry.getProtocolReadiness("heartbeat-agent").ready).toBe(false);
    const touch = vi.spyOn(agentRegistry, "touchLiveness");
    await handleAgentHeartbeat(socket, {
      ...frame("invalid", true),
      signature: { alg: "hmac-sha256", value: "invalid", key_id: "invalid-test-key" },
    });
    expect(touch).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenLastCalledWith(
      socketEvents.appError,
      expect.objectContaining({ code: "SOCKET_PROTOCOL_ERROR" }),
    );
    touch.mockRestore();
  });

  it("contains failed decoding and permits the next queued heartbeat", async () => {
    const socket = buildSocket();
    register(socket);
    asyncDecoder.mockRejectedValueOnce(new Error("decode failure"));
    const first = handleAgentHeartbeat(socket, frame("bad", true));
    const next = handleAgentHeartbeat(socket, frame("next"));
    await expect(first).rejects.toThrow("decode failure");
    await next;
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });
});
