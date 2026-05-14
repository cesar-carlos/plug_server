import { describe, expect, it } from "vitest";

import { parseAgentReadyPayload } from "../../../../../src/presentation/socket/hub/agent_ready_payload";

describe("parseAgentReadyPayload", () => {
  it("accepts complete Communication 2.10 agent:ready payloads", () => {
    expect(
      parseAgentReadyPayload({
        agent_id: "agent-1",
        timestamp: "2026-05-14T12:00:00.000Z",
        protocol: "plug-jsonrpc-profile/2.10",
      }),
    ).toEqual({
      ok: true,
      agentId: "agent-1",
      legacy: false,
    });
  });

  it("accepts legacy payloads only when timestamp and protocol are both absent", () => {
    expect(parseAgentReadyPayload({ agent_id: "agent-1" })).toEqual({
      ok: true,
      agentId: "agent-1",
      legacy: true,
    });
  });

  it("rejects partial or invalid payloads", () => {
    expect(parseAgentReadyPayload({ agent_id: "agent-1", timestamp: "bad" })).toEqual({
      ok: false,
      reason: "invalid_partial_payload",
    });
    expect(
      parseAgentReadyPayload({
        agent_id: "agent-1",
        timestamp: "2026-05-14T12:00:00.000Z",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_partial_payload",
    });
    expect(parseAgentReadyPayload({ agent_id: "" })).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });
});
