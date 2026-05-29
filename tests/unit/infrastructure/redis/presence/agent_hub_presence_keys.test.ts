import { describe, expect, it } from "vitest";

import {
  agentHubBridgeCmdChannel,
  agentHubBridgeReplyChannel,
  agentHubPresenceKey,
} from "../../../../../src/infrastructure/redis/presence/agent_hub_presence_keys";

describe("agent_hub_presence_keys", () => {
  it("embeds the plug hash tag in presence and bridge channels", () => {
    expect(agentHubPresenceKey("agent-1")).toContain("{plug}");
    expect(agentHubBridgeCmdChannel("hub-a")).toContain("{plug}");
    expect(agentHubBridgeReplyChannel("corr-1")).toContain("{plug}");
  });

  it("sanitizes unsafe agent id segments", () => {
    expect(agentHubPresenceKey("bad/id")).toMatch(/bad_id$/);
  });
});
