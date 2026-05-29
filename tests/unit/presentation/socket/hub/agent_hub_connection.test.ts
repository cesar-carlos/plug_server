import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentRegistry } from "../../../../../src/presentation/socket/hub/registries/agent_registry";
import { isAgentConnectedToHub } from "../../../../../src/presentation/socket/hub/agent_hub_connection";

const presenceMock = {
  isEnabled: true,
  upsert: vi.fn(),
  touch: vi.fn(),
  removeIfSocketMatches: vi.fn(),
  removeIfHubInstanceMatches: vi.fn(),
  resolveRoute: vi.fn(),
};

vi.mock("../../../../../src/infrastructure/redis/presence/agent_hub_presence_redis", () => ({
  getAgentHubPresencePort: () => presenceMock,
}));

describe("isAgentConnectedToHub", () => {
  beforeEach(() => {
    agentRegistry.clear();
    presenceMock.resolveRoute.mockReset();
    presenceMock.isEnabled = true;
  });

  afterEach(() => {
    agentRegistry.clear();
  });

  it("returns false when the agent is absent locally and in Redis", async () => {
    presenceMock.resolveRoute.mockResolvedValue(null);
    await expect(isAgentConnectedToHub("00000000-0000-4000-8000-000000000001")).resolves.toBe(
      false,
    );
  });

  it("returns true when registered locally", async () => {
    agentRegistry.upsert({
      agentId: "00000000-0000-4000-8000-000000000002",
      socketId: "socket-1",
      userId: null,
      capabilities: {},
    });
    await expect(isAgentConnectedToHub("00000000-0000-4000-8000-000000000002")).resolves.toBe(
      true,
    );
    expect(presenceMock.resolveRoute).not.toHaveBeenCalled();
  });

  it("returns true when presence resolves a route on another replica", async () => {
    presenceMock.resolveRoute.mockResolvedValue({ hubInstanceId: "hub-remote" });
    await expect(isAgentConnectedToHub("00000000-0000-4000-8000-000000000003")).resolves.toBe(
      true,
    );
  });
});
