import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/presentation/socket/hub/rpc_bridge", () => ({
  requestAgentStreamPull: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/active_stream_registry", () => ({
  getActiveStreamRouteByRequestId: vi.fn(),
  getActiveStreamRouteByStreamId: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/agent_registry", () => ({
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

import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { handleAgentsStreamPull } from "../../../../../src/presentation/socket/consumers/agents_stream_pull.handler";
import { requestAgentStreamPull } from "../../../../../src/presentation/socket/hub/rpc_bridge";
import {
  getActiveStreamRouteByRequestId,
  getActiveStreamRouteByStreamId,
} from "../../../../../src/presentation/socket/hub/active_stream_registry";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import { tryAcquireSocketInflightSlot } from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";

const mockedRequestAgentStreamPull = vi.mocked(requestAgentStreamPull);
const mockedGetActiveStreamRouteByRequestId = vi.mocked(getActiveStreamRouteByRequestId);
const mockedGetActiveStreamRouteByStreamId = vi.mocked(getActiveStreamRouteByStreamId);
const mockedFindBySocketId = vi.mocked(agentRegistry.findBySocketId);
const mockedAssertAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);

const buildSocket = () =>
  ({
    id: "consumer-1",
    data: { user: { sub: "user-1", principal_type: "user", role: "user" } },
    emit: vi.fn(),
  }) as const;

describe("handleAgentsStreamPull", () => {
  beforeEach(() => {
    mockedRequestAgentStreamPull.mockReset();
    mockedGetActiveStreamRouteByRequestId.mockReset();
    mockedGetActiveStreamRouteByStreamId.mockReset();
    mockedFindBySocketId.mockReset();
    mockedAssertAccess.mockReset();
    mockedTryAcquire.mockReset();

    mockedTryAcquire.mockReturnValue(true);
    mockedGetActiveStreamRouteByRequestId.mockReturnValue({
      agentSocketId: "agent-socket-1",
    } as never);
    mockedFindBySocketId.mockReturnValue({ agentId: "agent-1" } as never);
    mockedAssertAccess.mockResolvedValue({ type: "user", id: "user-1", role: "user" });
    mockedRequestAgentStreamPull.mockReturnValue({
      requestId: "req-1",
      streamId: "stream-1",
      windowSize: 16,
    });
  });

  it("emits protocol error when payload is not an object", () => {
    const socket = buildSocket();

    handleAgentsStreamPull(socket as never, "invalid");

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.appError, {
      message: "agents:stream_pull payload must be an object",
      code: "SOCKET_PROTOCOL_ERROR",
    });
  });

  it("returns RATE_LIMITED when the per-socket inflight gate is full", () => {
    const socket = buildSocket();
    mockedTryAcquire.mockReturnValue(false);

    handleAgentsStreamPull(socket as never, { requestId: "req-1" });

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentsStreamPullResponse, {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
  });
});
