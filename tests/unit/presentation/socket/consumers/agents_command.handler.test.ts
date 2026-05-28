import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentDisconnectedBeforeDispatchError } from "../../../../../src/shared/errors/agent_disconnected_before_dispatch.error";
import { AppError } from "../../../../../src/shared/errors/app_error";
import { buildLegacySocketAppErrorPayload } from "../../../../../src/shared/constants/socket_app_error";
import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import {
  decodePayloadFrame,
  encodePayloadFrame,
  isPayloadFrameEnvelope,
} from "../../../../../src/shared/utils/payload_frame";

vi.mock("../../../../../src/application/agent_commands/execute_authorized_agent_command", () => ({
  executeAuthorizedAgentCommand: vi.fn(),
}));

vi.mock("../../../../../src/application/services/bridge_latency_trace_builder", () => ({
  createBridgeLatencyTraceIfSampled: vi.fn(),
  createBridgeLatencyTraceForRequest: vi.fn(),
  BRIDGE_LATENCY_PHASES_SCHEMA_VERSION: 1,
}));

vi.mock(
  "../../../../../src/presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter",
  () => ({
    allowAgentsCommandSocketAsync: vi.fn(),
    estimateAgentsCommandRateLimitCost: vi.fn(() => 1),
  }),
);

vi.mock("../../../../../src/presentation/socket/consumers/consumer_socket_guard", () => ({
  assertConsumerSocketAgentAccess: vi.fn(),
}));

vi.mock("../../../../../src/presentation/socket/consumers/per_socket_inflight_gate", () => ({
  tryAcquireSocketInflightSlot: vi.fn(() => true),
  releaseSocketInflightSlot: vi.fn(),
}));

vi.mock("../../../../../src/shared/metrics/socket_consumer.metrics", () => ({
  noteSocketErrorRetryAfterMsPropagated: vi.fn(),
  noteAgentsCommandRetryAfterSecondsPropagated: vi.fn(),
  noteServerTimingsOptIn: vi.fn(),
}));

import { executeAuthorizedAgentCommand } from "../../../../../src/application/agent_commands/execute_authorized_agent_command";
import {
  createBridgeLatencyTraceForRequest,
  createBridgeLatencyTraceIfSampled,
} from "../../../../../src/application/services/bridge_latency_trace_builder";
import { handleAgentsCommand } from "../../../../../src/presentation/socket/consumers/agents_command.handler";
import { allowAgentsCommandSocketAsync } from "../../../../../src/presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";
import { assertConsumerSocketAgentAccess } from "../../../../../src/presentation/socket/consumers/consumer_socket_guard";
import {
  releaseSocketInflightSlot,
  tryAcquireSocketInflightSlot,
} from "../../../../../src/presentation/socket/consumers/per_socket_inflight_gate";
import { noteServerTimingsOptIn } from "../../../../../src/shared/metrics/socket_consumer.metrics";

const mockedExecuteAuthorizedAgentCommand = vi.mocked(executeAuthorizedAgentCommand);
const mockedCreateBridgeLatencyTraceIfSampled = vi.mocked(createBridgeLatencyTraceIfSampled);
const mockedCreateBridgeLatencyTraceForRequest = vi.mocked(createBridgeLatencyTraceForRequest);
const mockedAllowAgentsCommandSocket = vi.mocked(allowAgentsCommandSocketAsync);
const mockedAssertConsumerSocketAgentAccess = vi.mocked(assertConsumerSocketAgentAccess);
const mockedTryAcquire = vi.mocked(tryAcquireSocketInflightSlot);
const mockedReleaseInflight = vi.mocked(releaseSocketInflightSlot);

const buildSocket = () =>
  ({
    id: "consumer-socket-1",
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

const expectAgentsCommandResponse = (
  emitMock: ReturnType<typeof vi.fn>,
  logical: Record<string, unknown>,
): void => {
  expect(emitMock).toHaveBeenCalledWith(socketEvents.agentsCommandResponse, expect.anything());
  const wirePayload = emitMock.mock.calls.find(
    (call) => call[0] === socketEvents.agentsCommandResponse,
  )?.[1];
  expect(wirePayload).toBeDefined();
  expect(isPayloadFrameEnvelope(wirePayload)).toBe(true);
  const decoded = decodePayloadFrame(wirePayload);
  expect(decoded.ok).toBe(true);
  if (decoded.ok) {
    expect(decoded.value.data).toMatchObject(logical);
  }
};

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
    mockedCreateBridgeLatencyTraceForRequest.mockReset();
    mockedAllowAgentsCommandSocket.mockReset();
    mockedAssertConsumerSocketAgentAccess.mockReset();
    mockedTryAcquire.mockReset();
    mockedReleaseInflight.mockReset();

    mockedTryAcquire.mockReturnValue(true);

    mockedAllowAgentsCommandSocket.mockResolvedValue(true);
    mockedAssertConsumerSocketAgentAccess.mockResolvedValue({
      type: "user",
      id: "user-1",
      role: "user",
    });
    const traceStub = {
      addPhaseMs: vi.fn(),
      finalizeOnce: vi.fn(),
      isFinalized: vi.fn(() => false),
      getPhasesSnapshot: vi.fn(() => ({ encode_ms: 1.5, emit_to_socket_ms: 0.2 })),
    } as never;
    mockedCreateBridgeLatencyTraceIfSampled.mockReturnValue(traceStub);
    mockedCreateBridgeLatencyTraceForRequest.mockReturnValue(traceStub);
  });

  it("emits protocol error when payload is not an object or PayloadFrame", () => {
    const socket = buildSocket();

    handleAgentsCommand(socket as never, "invalid");

    expect(socket.emit).toHaveBeenCalledWith(
      socketEvents.appError,
      buildLegacySocketAppErrorPayload(
        "SOCKET_PROTOCOL_ERROR",
        "agents:command payload must be an object or PayloadFrame",
      ),
    );
  });

  it("accepts inbound PayloadFrame and emits framed command response", async () => {
    const socket = buildSocket();
    mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
      requestId: "req-1",
      response: {
        type: "single",
        success: true,
        item: { id: "req-1", result: { ok: true } },
      },
    } as never);

    handleAgentsCommand(
      socket as never,
      encodePayloadFrame(validPayload, { requestId: "req-1", omitTraceId: true }),
    );

    await vi.waitFor(() => {
      expectAgentsCommandResponse(socket.emit, {
        success: true,
        requestId: "req-1",
        response: {
          type: "single",
          success: true,
          item: { id: "req-1", result: { ok: true } },
        },
      });
    });
  });

  it("emits validation error response when payload schema is invalid", () => {
    const socket = buildSocket();

    handleAgentsCommand(socket as never, { agentId: "agent-1" });

    expectAgentsCommandResponse(socket.emit, {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("returns RATE_LIMITED when the per-socket inflight gate is full", () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = buildSocket();

    handleAgentsCommand(socket as never, validPayload);

    expect(mockedAllowAgentsCommandSocket).not.toHaveBeenCalled();
    expect(mockedReleaseInflight).not.toHaveBeenCalled();
    expectAgentsCommandResponse(socket.emit, {
      success: false,
      requestId: "req-1",
      error: {
        code: "RATE_LIMITED",
        message: "Per-socket inflight gate exceeded",
        statusCode: 429,
      },
    });
  });

  it("includes command id as requestId on validation errors when present", () => {
    const socket = buildSocket();

    handleAgentsCommand(socket as never, {
      agentId: "agent-1",
      command: {
        jsonrpc: "2.0",
        id: "partial-req-1",
        method: "sql.execute",
      },
    });

    expectAgentsCommandResponse(socket.emit, {
      success: false,
      requestId: "partial-req-1",
      error: {
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("does not emit command response when socket is disconnected", async () => {
    mockedTryAcquire.mockReturnValue(false);
    const socket = { ...buildSocket(), connected: false };

    handleAgentsCommand(socket as never, validPayload);

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("rejects when socket command rate limit is exceeded", async () => {
    const socket = buildSocket();
    mockedAllowAgentsCommandSocket.mockResolvedValue(false);

    handleAgentsCommand(socket as never, validPayload);

    await vi.waitFor(() => {
      expectAgentsCommandResponse(socket.emit, {
        success: false,
        requestId: "req-1",
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "Too many agent commands, please try again later.",
          statusCode: 429,
        },
      });
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
      expectAgentsCommandResponse(socket.emit, {
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
      expectAgentsCommandResponse(socket.emit, {
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

  it("adds retryAfterSeconds for normalized RPC rate-limit errors", async () => {
    const socket = buildSocket();
    mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
      requestId: "req-1",
      response: {
        type: "single",
        success: false,
        item: {
          id: "req-1",
          success: false,
          error: {
            code: -32013,
            message: "rate_limited",
            data: { retry_after_ms: 2500 },
          },
        },
      },
    } as never);

    handleAgentsCommand(socket as never, validPayload);

    await vi.waitFor(() => {
      expectAgentsCommandResponse(socket.emit, {
        success: true,
        requestId: "req-1",
        retryAfterSeconds: 3,
      });
    });
  });

  it("emits normalized agent_offline when execution throws AgentDisconnectedBeforeDispatchError", async () => {
    const socket = buildSocket();
    mockedExecuteAuthorizedAgentCommand.mockRejectedValue(
      new AgentDisconnectedBeforeDispatchError("agent-1", validPayload.command),
    );

    handleAgentsCommand(socket as never, validPayload);

    await vi.waitFor(() => {
      expectAgentsCommandResponse(socket.emit, {
        success: true,
        requestId: "req-1",
        response: {
          type: "single",
          success: false,
          item: {
            id: "req-1",
            success: false,
            error: {
              code: -32_000,
              message: "agent_offline",
              data: {
                reason: "agent_disconnected_at_dispatch",
                agent_id: "agent-1",
              },
            },
          },
        },
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
      expectAgentsCommandResponse(socket.emit, {
        success: false,
        requestId: "req-1",
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Agent unavailable",
          statusCode: 503,
        },
      });
    });
  });

  describe("requestServerTimings opt-in", () => {
    it("does not include serverTimings on the response when the flag is absent", async () => {
      const socket = buildSocket();
      mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
        requestId: "req-1",
        response: {
          type: "single",
          success: true,
          item: { id: "req-1", result: { ok: true } },
        },
      } as never);

      handleAgentsCommand(socket as never, validPayload);

      await vi.waitFor(() => {
        const wirePayload = socket.emit.mock.calls.find(
          (call) => call[0] === socketEvents.agentsCommandResponse,
        )?.[1];
        expect(wirePayload).toBeDefined();
        const decoded = decodePayloadFrame(wirePayload);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.value.data).not.toHaveProperty("serverTimings");
        }
      });
    });

    it("attaches serverTimings to the success envelope when the flag is set", async () => {
      const socket = buildSocket();
      mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
        requestId: "req-1",
        response: {
          type: "single",
          success: true,
          item: { id: "req-1", result: { ok: true } },
        },
      } as never);

      handleAgentsCommand(socket as never, { ...validPayload, requestServerTimings: true });

      await vi.waitFor(() => {
        const wirePayload = socket.emit.mock.calls.find(
          (call) => call[0] === socketEvents.agentsCommandResponse,
        )?.[1];
        expect(wirePayload).toBeDefined();
        const decoded = decodePayloadFrame(wirePayload);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.value.data).toMatchObject({
            success: true,
            serverTimings: {
              schemaVersion: 1,
              phasesMs: expect.any(Object),
            },
          });
        }
      });
    });

    it("forces an active latency trace when the consumer requested serverTimings", () => {
      const socket = buildSocket();
      mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
        requestId: "req-1",
        response: { type: "single", success: true, item: { id: "req-1", result: {} } },
      } as never);

      handleAgentsCommand(socket as never, { ...validPayload, requestServerTimings: true });

      expect(mockedCreateBridgeLatencyTraceForRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "consumer_socket",
          userId: "user-1",
          forceActive: true,
        }),
      );
    });

    it("increments serverTimings opt-in counter for the agents_command channel", () => {
      vi.mocked(noteServerTimingsOptIn).mockClear();
      const socket = buildSocket();
      mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
        requestId: "req-1",
        response: { type: "single", success: true, item: { id: "req-1", result: {} } },
      } as never);

      handleAgentsCommand(socket as never, { ...validPayload, requestServerTimings: true });

      expect(noteServerTimingsOptIn).toHaveBeenCalledWith("agents_command");
    });

    it("does not increment serverTimings opt-in counter when the flag is absent", () => {
      vi.mocked(noteServerTimingsOptIn).mockClear();
      const socket = buildSocket();
      mockedExecuteAuthorizedAgentCommand.mockResolvedValue({
        requestId: "req-1",
        response: { type: "single", success: true, item: { id: "req-1", result: {} } },
      } as never);

      handleAgentsCommand(socket as never, validPayload);

      expect(noteServerTimingsOptIn).not.toHaveBeenCalled();
    });
  });
});
