import { describe, expect, it } from "vitest";

import {
  evaluateAgentRegisterHandshake,
  markAgentRegisterSocketDisconnected,
} from "../../../../../src/presentation/socket/hub/handshake/agent_register_handshake_state";
import type { AgentHubSocket } from "../../../../../src/presentation/socket/hub/handlers/_shared";

const socket = (): AgentHubSocket => ({ id: "sock-1", data: {} }) as unknown as AgentHubSocket;

describe("evaluateAgentRegisterHandshake", () => {
  it("coalesces a second identical register onto the inflight promise", async () => {
    const current = socket();
    const first = evaluateAgentRegisterHandshake({
      socket: current,
      agentId: "agent-1",
      frameRequestId: "req-1",
      capabilitiesKey: "caps-a",
    });
    expect(first.action).toBe("proceed");
    const second = evaluateAgentRegisterHandshake({
      socket: current,
      agentId: "agent-1",
      frameRequestId: "req-1",
      capabilitiesKey: "caps-a",
    });
    expect(second.action).toBe("coalesce");
    if (second.action === "coalesce") {
      markAgentRegisterSocketDisconnected(current);
      await expect(second.inflight).resolves.toBeUndefined();
    }
  });

  it("rejects a different agentId while registering", () => {
    const current = socket();
    evaluateAgentRegisterHandshake({
      socket: current,
      agentId: "agent-1",
      frameRequestId: "req-1",
      capabilitiesKey: "caps-a",
    });
    const second = evaluateAgentRegisterHandshake({
      socket: current,
      agentId: "agent-2",
      frameRequestId: "req-2",
      capabilitiesKey: "caps-b",
    });
    expect(second.action).toBe("reject");
  });
});
