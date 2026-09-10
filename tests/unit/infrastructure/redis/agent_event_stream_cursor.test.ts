import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {
    del: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  };
  return { client, getClient: vi.fn(() => client) };
});

vi.mock("../../../../src/infrastructure/redis/event_stream/agent_event_stream", () => ({
  getAgentEventStreamRedisClient: mocks.getClient,
}));

vi.mock("../../../../src/shared/config/env", () => ({
  env: { agentEventStreamTtlMs: 60_000, redisTenantId: "" },
}));

import {
  commitAgentEventCursor,
  getAgentEventCursor,
  purgeAgentEventCursor,
} from "../../../../src/infrastructure/redis/event_stream/agent_event_stream_cursor";

describe("agent_event_stream_cursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockReturnValue(mocks.client);
    mocks.client.get.mockResolvedValue(null);
    mocks.client.set.mockResolvedValue("OK");
    mocks.client.del.mockResolvedValue(1);
  });

  it("persists independent cursors for different events of the same principal", async () => {
    await commitAgentEventCursor("principal-1", "client:custom.alpha", "10-0");
    await commitAgentEventCursor("principal-1", "client:custom.beta", "20-0");

    const [alphaKey] = mocks.client.set.mock.calls[0] ?? [];
    const [betaKey] = mocks.client.set.mock.calls[1] ?? [];
    expect(alphaKey).toMatch(/^plug_agent_stream_cursor_v2:\{plug\}:principal-1:[a-f0-9]{32}$/);
    expect(betaKey).toMatch(/^plug_agent_stream_cursor_v2:\{plug\}:principal-1:[a-f0-9]{32}$/);
    expect(alphaKey).not.toBe(betaKey);
  });

  it("uses the event-specific key for reads and cleanup", async () => {
    await getAgentEventCursor("principal-1", "client:custom.alpha");
    await purgeAgentEventCursor("principal-1", "client:custom.alpha");

    expect(mocks.client.get).toHaveBeenCalledTimes(1);
    expect(mocks.client.del).toHaveBeenCalledWith(mocks.client.get.mock.calls[0]?.[0]);
  });
});
