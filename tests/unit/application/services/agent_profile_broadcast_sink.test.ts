import { describe, expect, it, vi } from "vitest";

import {
  emitAgentProfileBroadcastEvent,
  registerAgentProfileBroadcastHandler,
} from "../../../../src/application/services/agent_profile_broadcast_sink";

describe("agent_profile_broadcast_sink", () => {
  it("broadcasts to all registered handlers and disposer removes only its own handler", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const disposeFirst = registerAgentProfileBroadcastHandler(first);
    const disposeSecond = registerAgentProfileBroadcastHandler(second);

    await emitAgentProfileBroadcastEvent({
      agentId: "agent-1",
      profileVersion: 2,
      profileUpdatedAt: "2026-05-14T00:00:00.000Z",
      source: "test",
      changedFields: ["tradeName"],
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    disposeFirst();
    await emitAgentProfileBroadcastEvent({
      agentId: "agent-2",
      profileVersion: 3,
      profileUpdatedAt: null,
      source: "test-2",
      changedFields: [],
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    disposeSecond();
  });
});
