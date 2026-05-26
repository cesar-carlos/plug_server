import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/presentation/socket/hub/relay/rpc_bridge", () => ({
  prepareLegacyAgentStreamPull: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/registries/active_stream_registry", () => ({
  getActiveStreamRouteByRequestId: vi.fn(),
  getActiveStreamRouteByStreamId: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/registries/agent_registry", () => ({
  agentRegistry: {
    findBySocketId: vi.fn(),
  },
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter", () => ({
  allowAgentsCommandSocketAsync: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter", () => ({
  allowAgentsStreamPullCredits: vi.fn(() =>
    Promise.resolve({
      allowed: true,
      scope: "user",
      limit: 0,
      requestedCredits: 16,
      grantedCredits: 16,
      remainingCredits: Number.MAX_SAFE_INTEGER,
    }),
  ),
  refundAgentsStreamPullCredits: vi.fn(),
}));

import { buildLegacySocketAppErrorPayload } from "../../../../../src/shared/constants/socket_app_error";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../../../src/shared/utils/payload_frame";
import { handleAgentsStreamPull } from "../../../../../src/presentation/socket/consumers/agents_stream_pull.handler";
import { abortPendingConsumerCommands } from "../../../../../src/presentation/socket/consumers/consumer_command_abort_registry";
import { prepareLegacyAgentStreamPull } from "../../../../../src/presentation/socket/hub/relay/rpc_bridge";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
} from "../../../../../src/presentation/socket/hub/registries/active_stream_registry";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { allowAgentsCommandSocketAsync } from "../../../../../src/presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";
import {
  allowAgentsStreamPullCredits,
  refundAgentsStreamPullCredits,
} from "../../../../../src/presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import { tryAcquireSocketInflightSlot } from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";
import { AppError } from "../../../../../src/shared/errors/app_error";

const mockedPrepareAgentStreamPull = vi.mocked(prepareLegacyAgentStreamPull);
const mockedGetActiveStreamRouteByRequestId = vi.mocked(getActiveStreamRouteByRequestId);
const mockedGetActiveStreamRouteByStreamId = vi.mocked(getActiveStreamRouteByStreamId);
const mockedFindBySocketId = vi.mocked(agentRegistry.findBySocketId);
const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);
const mockedAllowAgentsCommandSocket = vi.mocked(allowAgentsCommandSocketAsync);
const mockedAllowAgentsStreamPullCredits = vi.mocked(allowAgentsStreamPullCredits);
const mockedRefundAgentsStreamPullCredits = vi.mocked(refundAgentsStreamPullCredits);

const buildSocket = () =>
  ({
    id: "consumer-1",
    connected: true,
    data: { user: { sub: "user-1", principal_type: "user", role: "user" } },
    emit: vi.fn(),
  }) as const;

const expectAgentsStreamPullResponse = (
  emitMock: ReturnType<typeof vi.fn>,
  logical: Record<string, unknown>,
): void => {
  expect(emitMock).toHaveBeenCalledWith(socketEvents.agentsStreamPullResponse, expect.anything());
  const wirePayload = emitMock.mock.calls.find(
    (call) => call[0] === socketEvents.agentsStreamPullResponse,
  )?.[1];
  expect(wirePayload).toBeDefined();
  expect(isPayloadFrameEnvelope(wirePayload)).toBe(true);
  const decoded = decodePayloadFrame(wirePayload);
  expect(decoded.ok).toBe(true);
  if (decoded.ok) {
    expect(decoded.value.data).toMatchObject(logical);
  }
};

describe("handleAgentsStreamPull", () => {
  beforeEach(() => {
    mockedPrepareAgentStreamPull.mockReset();
    mockedGetActiveStreamRouteByRequestId.mockReset();
    mockedGetActiveStreamRouteByStreamId.mockReset();
    mockedFindBySocketId.mockReset();
    mockedAssertAccess.mockReset();
    mockedTryAcquire.mockReset();
    mockedAllowAgentsCommandSocket.mockReset();
    mockedAllowAgentsStreamPullCredits.mockReset();
    mockedRefundAgentsStreamPullCredits.mockReset();

    mockedTryAcquire.mockReturnValue(true);
    mockedAllowAgentsCommandSocket.mockResolvedValue(true);
    mockedAllowAgentsStreamPullCredits.mockResolvedValue({
      allowed: true,
      scope: "user",
      limit: 0,
      requestedCredits: 16,
      grantedCredits: 16,
      remainingCredits: Number.MAX_SAFE_INTEGER,
    });
    mockedGetActiveStreamRouteByRequestId.mockReturnValue({
      agentSocketId: "agent-socket-1",
    } as never);
    mockedGetActiveStreamRouteByStreamId.mockReturnValue({
      agentSocketId: "agent-socket-1",
    } as never);
    mockedFindBySocketId.mockReturnValue({ agentId: "agent-1" } as never);
    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
    mockedPrepareAgentStreamPull.mockReturnValue({
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 16,
      execute: vi.fn(() => ({
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 16,
      })),
    });
  });

  it("emits protocol error when payload is not an object or PayloadFrame", () => {
    const socket = buildSocket();

    handleAgentsStreamPull(socket as never, "invalid");

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.appError,
      buildLegacySocketAppErrorPayload(
        "SOCKET_PROTOCOL_ERROR",
        "agents:stream_pull payload must be an object or PayloadFrame",
      ),
    );
  });

  it("accepts inbound PayloadFrame during the migration window", async () => {
    const socket = buildSocket();
    const framed = encodePayloadFrame(
      { requestId: "req-1", windowSize: 16 },
      { requestId: "req-1" },
    );

    handleAgentsStreamPull(socket as never, framed);

    await vi.waitFor(() => {
      expectAgentsStreamPullResponse(socket.emit, {
        success: true,
        requestId: "req-1",
        streamId: "stream-1",
        windowSize: 16,
      });
    });
  });

  it("returns RATE_LIMITED when the per-socket inflight gate is full", () => {
    const socket = buildSocket();
    mockedTryAcquire.mockReturnValue(false);

    handleAgentsStreamPull(socket as never, { requestId: "req-1" });

    expectAgentsStreamPullResponse(socket.emit, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
  });

  it("does not emit stream pull response when socket is disconnected", () => {
    const socket = { ...buildSocket(), connected: false };
    mockedTryAcquire.mockReturnValue(false);

    handleAgentsStreamPull(socket as never, { requestId: "req-1" });

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("returns TOO_MANY_REQUESTS when the shared agents:command budget is exhausted", async () => {
    const socket = buildSocket();
    mockedAllowAgentsCommandSocket.mockResolvedValue(false);

    handleAgentsStreamPull(socket as never, { requestId: "req-1" });

    await vi.waitFor(() => {
      expectAgentsStreamPullResponse(socket.emit, {
        success: false,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "Too many agent stream pulls, please try again later.",
          statusCode: 429,
        },
      });
    });
  });

  it("does not pull from the agent if the consumer disconnects while access is being checked", async () => {
    const socket = buildSocket();
    let resolveAccess!: () => void;
    mockedAssertAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccess = () => resolve({ type: "user", id: "user-1", role: "user" });
        }),
    );

    handleAgentsStreamPull(socket as never, { requestId: "req-1" });

    await vi.waitFor(() => expect(mockedAssertAccess).toHaveBeenCalled());
    expect(abortPendingConsumerCommands("consumer-1")).toBe(1);
    resolveAccess();

    await vi.waitFor(() => {
      expectAgentsStreamPullResponse(socket.emit, {
        success: false,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Consumer socket disconnected before stream pull completed",
          statusCode: 503,
        },
      });
    });
    expect(mockedPrepareAgentStreamPull).toHaveBeenCalled();
  });

  it("still emits stream pull error response when credit refund fails", async () => {
    const socket = buildSocket();
    mockedPrepareAgentStreamPull.mockReturnValue({
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 16,
      execute: vi.fn(() => {
        throw new AppError("Stream pull failed", { code: "STREAM_PULL_FAILED", statusCode: 503 });
      }),
    });
    mockedRefundAgentsStreamPullCredits.mockRejectedValue(new Error("redis unavailable"));

    handleAgentsStreamPull(socket as never, { requestId: "req-1" });

    await vi.waitFor(() => {
      expect(mockedRefundAgentsStreamPullCredits).toHaveBeenCalledWith("user-1", "consumer-1", 16);
      expectAgentsStreamPullResponse(socket.emit, {
        success: false,
        error: {
          code: "STREAM_PULL_FAILED",
          message: "Stream pull failed",
          statusCode: 503,
        },
      });
    });
  });
});
