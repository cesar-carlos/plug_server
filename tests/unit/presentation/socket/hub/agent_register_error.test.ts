import { describe, expect, it, vi } from "vitest";

import { socketEvents } from "../../../../../src/shared/constants/socket_events";
import { emitAgentRegisterError } from "../../../../../src/presentation/socket/hub/agent_register_error";

interface FakeSocket {
  readonly id: string;
  readonly emit: ReturnType<typeof vi.fn>;
}

const createFakeSocket = (id = "socket-fake-1"): FakeSocket => ({
  id,
  emit: vi.fn(),
});

describe("emitAgentRegisterError (plug_agente agent:register_error contract)", () => {
  it("emits the agent:register_error event as PLAIN JSON, not a PayloadFrame", () => {
    const socket = createFakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitAgentRegisterError(socket as any, "invalid_request", "missing fields");

    expect(socket.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = socket.emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe(socketEvents.agentRegisterError);

    // PayloadFrame envelopes always carry these fields; the register_error
    // contract is plain JSON and must NOT have them.
    expect(payload).not.toHaveProperty("schemaVersion");
    expect(payload).not.toHaveProperty("enc");
    expect(payload).not.toHaveProperty("cmp");
    expect(payload).not.toHaveProperty("payload");
  });

  it.each([
    ["invalid_request", -32600],
    ["invalid_payload", -32009],
    ["authentication_failed", -32001],
    ["unauthorized", -32002],
    ["rate_limited", -32013],
    ["transient_failure", -32603],
    ["internal_error", -32603],
    ["session_active", -32014],
  ] as const)("maps reason `%s` to JSON-RPC code %i", (reason, expectedCode) => {
    const socket = createFakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitAgentRegisterError(socket as any, reason, "msg");

    const [, payload] = socket.emit.mock.calls[0] as [string, { code: number; reason: string }];
    expect(payload.code).toBe(expectedCode);
    expect(payload.reason).toBe(reason);
  });

  it("forwards message verbatim", () => {
    const socket = createFakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitAgentRegisterError(socket as any, "unauthorized", "Agent X is already linked to Y");

    const [, payload] = socket.emit.mock.calls[0] as [string, { message: string }];
    expect(payload.message).toBe("Agent X is already linked to Y");
  });

  it("does not throw when context is omitted", () => {
    const socket = createFakeSocket();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emitAgentRegisterError(socket as any, "transient_failure", "try later");
    }).not.toThrow();
  });

  it("includes optional details in payload when provided", () => {
    const socket = createFakeSocket();
    emitAgentRegisterError(
      socket as never,
      "session_active",
      "msg",
      { agentId: "x" },
      { code: "same_agent_session_active" },
    );

    const [, payload] = socket.emit.mock.calls[0] as [
      string,
      { details?: Record<string, unknown> },
    ];
    expect(payload.details).toEqual({ code: "same_agent_session_active" });
  });
});
