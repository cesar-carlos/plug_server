import { afterEach, describe, expect, it } from "vitest";

import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";

describe("agent_registry dispatch policy negotiation", () => {
  afterEach(() => {
    agentRegistry.clear();
  });

  it("falls back to hub defaults when agent has no capability hints", () => {
    agentRegistry.upsert({
      agentId: "agent-default",
      socketId: "socket-default",
      userId: "user-1",
      capabilities: {},
    });

    const policy = agentRegistry.resolveEffectiveDispatchPolicy("agent-default");
    expect(policy.maxRows).toBe(1_000_000);
    expect(policy.maxBatchSize).toBe(32);
    expect(policy.maxConcurrentStreams).toBe(1);
    expect(policy.allowsGzip).toBe(true);
    expect(policy.allowsNoneCompression).toBe(true);
  });

  it("applies minimum between hub contract and agent-advertised limits", () => {
    agentRegistry.upsert({
      agentId: "agent-limited",
      socketId: "socket-limited",
      userId: "user-2",
      capabilities: {
        compressions: ["none"],
        limits: {
          max_rows: 250,
          max_batch_size: 8,
          max_concurrent_streams: 1,
        },
      },
    });

    const policy = agentRegistry.resolveEffectiveDispatchPolicy("agent-limited");
    expect(policy.maxRows).toBe(250);
    expect(policy.maxBatchSize).toBe(8);
    expect(policy.maxConcurrentStreams).toBe(1);
    expect(policy.allowsGzip).toBe(false);
    expect(policy.allowsNoneCompression).toBe(true);
  });
});
