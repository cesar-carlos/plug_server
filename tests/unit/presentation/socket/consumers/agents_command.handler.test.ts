import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../../../../src/shared/errors/app_error";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";

vi.mock("../../../../../src/application/agent_commands/execute_authorized_agent_command", () => ({
  executeAuthorizedAgentCommand: vi.fn(),
}));

vi.mock("../../../../../src/application/services/bridge_latency_trace_builder", () => ({
  createBridgeLatencyTraceIfSampled: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/hub/agents_command_socket_rate_limiter", () => ({
  allowAgentsCommandSocket: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
}));

import { executeAuthorizedAgentCommand } from "../../../../../src/application/agent_commands/execute_authorized_agent_command";
import { createBridgeLatencyTraceIfSampled } from "../../../../../src/application/services/bridge_latency_trace_builder";
import { handleAgentsCommand } from "../../../../../src/presentation/socket/consumers/agents_command.handler";
import { allowAgentsCommandSocket } from "../../../../../src/presentation/socket/hub/agents_command_socket_rate_limiter";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";

const mockedExecuteAuthorizedAgentCommand = vi.mocked(executeAuthorizedAgentCommand);
const mockedCreateBridgeLatencyTraceIfSampled = vi.mocked(createBridgeLatencyTraceIfSampled);
const mockedAllowAgentsCommandSocket = vi.mocked(allowAgentsCommandSocket);
const mockedAssertConsumerSocketAgentAccess = vi.mocked(assertConsumerSocketAgentAccess);

const buildSocket = () =>
  ({
    id: "consumer-socket-1",
    data: {
      user: {
        sub: "user-1",
        principal_type: "user",
        role: "user",
      },
    },
    emit: vi.fn(),
  }) as const;

const validPayload = {
  agentId: "agent-1",
  command: {
    jsonrpc: "2.0",
    id: "req-1",
    method: "sql.execute",
    params: {
      sql: "SELECT 1",
    },
  },
};

describe("handleAgentsCommand", () => {
  beforeEach(() => {
    mockedExecuteAuthorizedAgentCommand.mockReset();
    mockedCreateBridgeLatencyTraceIfSampled.mockReset();
    mockedAllowAgentsCommandSocket.mockReset();
    mockedAssertConsumerSocketAgentAccess.mockReset();

    mockedAllowAgentsCommandSocket.mockReturnValue(true);
    mockedAssertConsumerSocketAgentAccess.mockResolvedValue({
      type: "user",
      id: "user-1",
      role: "user",
    });
    mockedCreateBridgeLatencyTraceIfSampled.mockReturnValue({
      addPhaseMs: vi.fn(),
      finalizeOnce: vi.fn(),
      isFinalized: vi.fn(() => false),
    } as never);
  });

  it("emits protocol error when payload is not an object", () => {
    const socket = buildSocket();

    handleAgentsCommand(socket as never, "invalid");

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.appError, {
      message: "agents:command payload must be an object",
      code: "SOCKET_PROTOCOL_ERROR",
    });
  });

  it("emits validation error response when payload schema is invalid", () => {
    const socket = buildSocket();

    handleAgentsCommand(socket as never, { agentId: "agent-1" });

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.agentsCommandResponse,
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "VALIDATION_ERROR",
        }),
      }),
    );
  });

  it("rejects when socket command rate limit is exceeded", () => {
    const socket = buildSocket();
    mockedAllowAgentsCommandSocket.mockReturnValue(false);

    handleAgentsCommand(socket as never, validPayload);

    expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentsCommandResponse, {
      success: false,
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many agent commands, please try again later.",
        statusCode: 429,
      },
    });
  });

  it("emits accepted notification responses for notification commands", async () => {
    const socket = buildSocket();
    mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
      notification: true,
      requestId: "notif-1",
      acceptedCommands: 1,
    } as never);

    handleAgentsCommand(socket as never, validPayload);

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentsCommandResponse, {
        success: true,
        requestId: "notif-1",
        response: {
          type: "notification",
          accepted: true,
          acceptedCommands: 1,
        },
      });
    });
  });

  it("emits success response and extracts streamId from normalized rpc result", async () => {
    const socket = buildSocket();
    mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
      requestId: "req-1",
      response: {
        type: "single",
        success: true,
        item: {
          id: "req-1",
          success: true,
          result: {
            stream_id: "stream-1",
            rows: [],
          },
        },
      },
    } as never);

    handleAgentsCommand(socket as never, validPayload);

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentsCommandResponse, {
        success: true,
        requestId: "req-1",
        response: {
          type: "single",
          success: true,
          item: {
            id: "req-1",
            success: true,
            result: {
              stream_id: "stream-1",
              rows: [],
            },
          },
        },
        streamId: "stream-1",
      });
    });
  });

  it("emits app error details when command execution throws an AppError", async () => {
    const socket = buildSocket();
    mockedExecuteAuthorizedAgentCommand.mockRejectedValue(
      new AppError("Agent unavailable", {
        statusCode: 503,
        code: "SERVICE_UNAVAILABLE",
      }),
    );

    handleAgentsCommand(socket as never, validPayload);

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(socketEvents.agentsCommandResponse, {
        success: false,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Agent unavailable",
          statusCode: 503,
        },
      });
    });
  });
});
