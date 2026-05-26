import { afterEach, describe, expect, it } from "vitest";

import { isAgentConnectedToHub } from "../../../../../src/presentation/socket/hub/agent_hub_connection";
import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";

describe("isAgentConnectedToHub", () => {
  afterEach(() => {
    agentRegistry.clear();
  });

  it("returns false when the agent is not registered", () => {
    expect(isAgentConnectedToHub("00000000-0000-4000-8000-000000000001")).toBe(false);
  });

  it("returns true after agent:register upserted the agent in this process", () => {
    agentRegistry.upsert({
      agentId: "00000000-0000-4000-8000-000000000002",
      socketId: "socket-1",
      userId: "user-1",
      capabilities: {},
    });
    expect(isAgentConnectedToHub("00000000-0000-4000-8000-000000000002")).toBe(true);
  });

  it("returns false after disconnect removed the socket", () => {
    agentRegistry.upsert({
      agentId: "00000000-0000-4000-8000-000000000003",
      socketId: "socket-2",
      userId: "user-1",
      capabilities: {},
    });
    agentRegistry.removeBySocketId("socket-2");
    expect(isAgentConnectedToHub("00000000-0000-4000-8000-000000000003")).toBe(false);
  });
});
