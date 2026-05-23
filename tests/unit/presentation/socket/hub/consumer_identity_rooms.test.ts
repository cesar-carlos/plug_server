import { describe, expect, it, vi } from "vitest";

import {
  buildConsumerAgentProfileRoom,
  buildConsumerClientAgentRoom,
  joinConsumerClientAgentRoom,
} from "../../../../../src/presentation/socket/hub/consumer_identity_rooms";

describe("consumer_identity_rooms", () => {
  it("joins only rooms that are still missing", async () => {
    const join = vi.fn().mockResolvedValue(undefined);
    const socket = {
      rooms: new Set<string>([
        buildConsumerClientAgentRoom({ clientId: "client-1", agentId: "agent-1" }),
      ]),
      join,
    };

    await joinConsumerClientAgentRoom(socket, {
      clientId: "client-1",
      agentId: "agent-1",
    });

    expect(join).toHaveBeenCalledWith([buildConsumerAgentProfileRoom("agent-1")]);
  });

  it("skips join when both memberships already exist", async () => {
    const clientRoom = buildConsumerClientAgentRoom({ clientId: "client-1", agentId: "agent-1" });
    const profileRoom = buildConsumerAgentProfileRoom("agent-1");
    const join = vi.fn().mockResolvedValue(undefined);
    const socket = {
      rooms: new Set<string>([clientRoom, profileRoom]),
      join,
    };

    await joinConsumerClientAgentRoom(socket, {
      clientId: "client-1",
      agentId: "agent-1",
    });

    expect(join).not.toHaveBeenCalled();
  });
});
