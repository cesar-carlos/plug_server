import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeAgentHubPresenceRedis,
  getAgentHubPresencePort,
  initAgentHubPresenceRedis,
} from "../../src/infrastructure/redis/presence/agent_hub_presence_redis";
import {
  assertInfrastructureOrSkip,
  integrationHookTimeoutMs,
  probeSocketIoRedisAdapterInfrastructure,
  type InfrastructureProbeResult,
} from "./helpers/integration_infrastructure";

describe("agent hub presence redis (integration)", () => {
  let infrastructureProbe: InfrastructureProbeResult = {
    ok: false,
    reason: "probe not started",
  };

  beforeAll(async () => {
    const infrastructure = await probeSocketIoRedisAdapterInfrastructure();
    infrastructureProbe = infrastructure.probe;
    if (!infrastructureProbe.ok) {
      return;
    }
    process.env.SOCKET_IO_REDIS_ADAPTER_URL = infrastructure.redisUrl;
    process.env.AGENT_HUB_PRESENCE_REDIS_URL = infrastructure.redisUrl;
    process.env.AGENT_HUB_PRESENCE_ENABLED = "true";
    process.env.HUB_INSTANCE_ID = "hub-presence-itest";
    await closeAgentHubPresenceRedis();
    await initAgentHubPresenceRedis();
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    await closeAgentHubPresenceRedis();
  });

  it("upserts, resolves, touches, and removes presence with socket guard", async (ctx) => {
    assertInfrastructureOrSkip(ctx, infrastructureProbe);
    const presence = getAgentHubPresencePort();
    expect(presence.isEnabled).toBe(true);

    const agentId = "00000000-0000-4000-8000-00000000c001";
    await presence.upsert(agentId, {
      hubInstanceId: "hub-presence-itest",
      socketId: "socket-1",
      connectedAtMs: Date.now(),
    });

    expect(await presence.resolveRoute(agentId)).toEqual({
      hubInstanceId: "hub-presence-itest",
    });

    await presence.touch(agentId);
    await presence.removeIfSocketMatches(agentId, "socket-wrong");
    expect(await presence.resolveRoute(agentId)).toEqual({
      hubInstanceId: "hub-presence-itest",
    });

    await presence.removeIfSocketMatches(agentId, "socket-1");
    expect(await presence.resolveRoute(agentId)).toBeNull();
  });
});
