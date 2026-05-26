import { describe, expect, it } from "vitest";

import {
  type AgentRegisterErrorPayload,
  type AgentSessionSupersededPayload,
  AGENT_SESSION_SUPERSEDED_MESSAGE,
  emitAgentRegisterError,
} from "../../src/presentation/socket/hub/handshake/agent_register_error";
import { socketEvents } from "../../src/shared/constants/socket_events";
import { isPayloadFrameEnvelope } from "../../src/shared/utils/payload_frame";

describe("socket agent plain-JSON event contracts", () => {
  it("documents agent:register_error as plain JSON with { code, reason, message, details? }", () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const socket = {
      id: "agent-socket-1",
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    };

    emitAgentRegisterError(
      socket as never,
      "unauthorized",
      "Agent belongs to another user",
      undefined,
      { agentId: "agent-1" },
    );

    expect(socketEvents.agentRegisterError).toBe("agent:register_error");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe("agent:register_error");

    const payload = emitted[0]?.payload as AgentRegisterErrorPayload;
    expect(payload).toEqual({
      code: -32002,
      reason: "unauthorized",
      message: "Agent belongs to another user",
      details: { agentId: "agent-1" },
    });
    expect(isPayloadFrameEnvelope(payload)).toBe(false);
    expect(payload).not.toHaveProperty("success");
    expect(payload).not.toHaveProperty("requestId");
    expect(payload).not.toHaveProperty("schemaVersion");
  });

  it("documents agent:session.superseded as plain JSON with { reason, message, policy }", () => {
    const payload: AgentSessionSupersededPayload = {
      reason: "session_superseded",
      message: AGENT_SESSION_SUPERSEDED_MESSAGE,
      policy: "takeover_disconnect_previous",
    };

    expect(socketEvents.agentSessionSuperseded).toBe("agent:session.superseded");
    expect(payload).toEqual({
      reason: "session_superseded",
      message: AGENT_SESSION_SUPERSEDED_MESSAGE,
      policy: "takeover_disconnect_previous",
    });
    expect(isPayloadFrameEnvelope(payload)).toBe(false);
    expect(payload).not.toHaveProperty("code");
    expect(payload).not.toHaveProperty("schemaVersion");
    expect(payload).not.toHaveProperty("enc");
  });
});
