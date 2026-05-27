import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AgentEventStreamModule from "../../../../src/infrastructure/redis/agent_event_stream";

const setupModule = async (
  options: {
    readonly enabled?: boolean;
    readonly maxLen?: number;
    readonly ttlMs?: number;
    readonly backlogMaxEntries?: number;
    readonly url?: string;
    readonly useConsumerGroups?: boolean;
  } = {},
): Promise<{
  readonly module: typeof AgentEventStreamModule;
  readonly client: {
    readonly on: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    readonly xAdd: ReturnType<typeof vi.fn>;
    readonly xRead: ReturnType<typeof vi.fn>;
    readonly xDel: ReturnType<typeof vi.fn>;
    readonly pExpire: ReturnType<typeof vi.fn>;
    readonly sendCommand: ReturnType<typeof vi.fn>;
    readonly multi: ReturnType<typeof vi.fn>;
    readonly ping: ReturnType<typeof vi.fn>;
  };
  readonly multiCalls: { method: string; args: unknown[] }[];
  readonly multiExecMock: ReturnType<typeof vi.fn>;
  readonly createClientMock: ReturnType<typeof vi.fn>;
}> => {
  vi.resetModules();

  /**
   * `multi()` returns a chainable transaction object whose `xAdd`/`pExpire`
   * record their calls (so tests can assert what was queued) and whose
   * `exec()` returns whatever the test pre-loaded via `multiExecMock`.
   */
  const multiCalls: { method: string; args: unknown[] }[] = [];
  const multiExecMock = vi.fn();
  const txChainable = {
    xAdd: vi.fn(function (this: unknown, ...args: unknown[]) {
      multiCalls.push({ method: "xAdd", args });
      return txChainable;
    }),
    pExpire: vi.fn(function (this: unknown, ...args: unknown[]) {
      multiCalls.push({ method: "pExpire", args });
      return txChainable;
    }),
    exec: multiExecMock,
  };
  const multiMock = vi.fn(() => {
    multiCalls.length = 0;
    return txChainable;
  });

  const client = {
    on: vi.fn(() => client),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    xAdd: vi.fn(),
    xRead: vi.fn(),
    xDel: vi.fn(),
    pExpire: vi.fn(),
    sendCommand: vi.fn(),
    multi: multiMock,
    ping: vi.fn().mockResolvedValue("PONG"),
  };
  const createClientMock = vi.fn(() => client);

  vi.doMock("../../../../src/shared/config/env", () => ({
    env: {
      agentEventStreamRedisUrl: options.url ?? "redis://localhost:6379",
      agentEventStreamEnabled: options.enabled ?? true,
      agentEventStreamMaxLen: options.maxLen ?? 100,
      agentEventStreamTtlMs: options.ttlMs ?? 60_000,
      agentEventStreamBacklogMaxEntries: options.backlogMaxEntries ?? 50,
      agentEventStreamAgentAllowlist: [],
      agentEventStreamDrainAckTimeoutMs: 1_000,
      agentEventStreamUseConsumerGroups: options.useConsumerGroups ?? false,
      agentEventStreamConsumerGroup: "plug_hub",
      hubInstanceId: "test-replica",
      redisDefaultConnectTimeoutMs: 5_000,
      redisTenantId: "",
      redisDefaultReconnectBaseMs: 200,
      redisDefaultReconnectMaxMs: 5_000,
    },
  }));
  vi.doMock("redis", () => ({ createClient: createClientMock }));

  const module = await import("../../../../src/infrastructure/redis/agent_event_stream");
  return { module, client, multiCalls, multiExecMock, createClientMock };
};

describe("agent_event_stream", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.doUnmock("../../../../src/shared/config/env");
    vi.doUnmock("redis");
  });

  it("appends a frame with MAXLEN trim and pExpire when initialised", async () => {
    const { module, client, multiCalls, multiExecMock } = await setupModule({
      maxLen: 250,
      ttlMs: 30_000,
    });
    multiExecMock.mockResolvedValue(["1700000000000-0", 1]);

    await module.initAgentEventStream();
    const id = await module.appendAgentEventFrame("agent-abc", {
      eventId: "evt-1",
      eventName: "client:custom.test",
      emittedAt: "2026-01-01T00:00:00.000Z",
      payload: '{"x":1}',
    });

    expect(id).toBe("1700000000000-0");
    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(multiCalls).toHaveLength(2);
    expect(multiCalls[0]?.method).toBe("xAdd");
    expect(multiCalls[0]?.args[0]).toBe("plug_agent_stream:{plug}:agent-abc");
    expect(multiCalls[0]?.args[1]).toBe("*");
    expect(multiCalls[0]?.args[2]).toMatchObject({
      schemaVersion: "1",
      eventId: "evt-1",
      eventName: "client:custom.test",
      payload: '{"x":1}',
    });
    expect(multiCalls[0]?.args[3]).toMatchObject({
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 250 },
    });
    expect(multiCalls[1]?.method).toBe("pExpire");
    expect(multiCalls[1]?.args).toEqual(["plug_agent_stream:{plug}:agent-abc", 30_000]);

    await module.closeAgentEventStream();
  });

  it("returns undefined and skips append when disabled", async () => {
    const { module, client } = await setupModule({ enabled: false });

    await module.initAgentEventStream();
    const id = await module.appendAgentEventFrame("agent-disabled", {
      eventId: "evt",
      eventName: "client:custom.x",
      emittedAt: "2026-01-01T00:00:00.000Z",
      payload: "{}",
    });

    expect(id).toBeUndefined();
    expect(client.multi).not.toHaveBeenCalled();
  });

  it("reads backlog entries and returns parsed frames in order", async () => {
    const { module, client } = await setupModule({ backlogMaxEntries: 10 });
    client.xRead.mockResolvedValue([
      {
        name: "plug_agent_stream:{plug}:agent-bk",
        messages: [
          {
            id: "100-0",
            message: {
              eventId: "e1",
              eventName: "client:custom.a",
              emittedAt: "2026-01-01T00:00:00.000Z",
              payload: '{"n":1}',
            },
          },
          {
            id: "101-0",
            message: {
              eventId: "e2",
              eventName: "client:custom.a",
              emittedAt: "2026-01-01T00:00:01.000Z",
              payload: '{"n":2}',
            },
          },
        ],
      },
    ]);

    await module.initAgentEventStream();
    const entries = await module.readAgentEventBacklog("agent-bk", "$");

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ streamId: "100-0", eventId: "e1" });
    expect(entries[1]).toMatchObject({ streamId: "101-0", eventId: "e2" });
    expect(client.xRead).toHaveBeenCalledWith(
      [{ key: "plug_agent_stream:{plug}:agent-bk", id: "$" }],
      { COUNT: 10 },
    );
  });

  it("ignores malformed stream messages without throwing", async () => {
    const { module, client } = await setupModule();
    client.xRead.mockResolvedValue([
      {
        name: "plug_agent_stream:{plug}:agent-bad",
        messages: [
          {
            id: "1-0",
            message: { eventId: "e1" /* missing other fields */ },
          },
          {
            id: "2-0",
            message: {
              eventId: "ok",
              eventName: "client:custom.x",
              emittedAt: "2026-01-01T00:00:00.000Z",
              payload: "{}",
            },
          },
        ],
      },
    ]);

    await module.initAgentEventStream();
    const entries = await module.readAgentEventBacklog("agent-bad", "$");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventId).toBe("ok");
  });

  it("rejects entries with unknown schemaVersion at parse time", async () => {
    const { module, client } = await setupModule();
    client.xRead.mockResolvedValue([
      {
        name: "plug_agent_stream:{plug}:agent-future",
        messages: [
          {
            id: "1-0",
            message: {
              schemaVersion: "999",
              eventId: "future",
              eventName: "client:custom.x",
              emittedAt: "2026-01-01T00:00:00.000Z",
              payload: "{}",
            },
          },
          {
            id: "2-0",
            message: {
              schemaVersion: "1",
              eventId: "current",
              eventName: "client:custom.x",
              emittedAt: "2026-01-01T00:00:00.000Z",
              payload: "{}",
            },
          },
        ],
      },
    ]);

    await module.initAgentEventStream();
    const entries = await module.readAgentEventBacklog("agent-future", "$");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventId).toBe("current");
  });

  it("accepts legacy entries without schemaVersion (back-compat)", async () => {
    const { module, client } = await setupModule();
    client.xRead.mockResolvedValue([
      {
        name: "plug_agent_stream:{plug}:agent-legacy",
        messages: [
          {
            id: "1-0",
            message: {
              eventId: "legacy",
              eventName: "client:custom.x",
              emittedAt: "2026-01-01T00:00:00.000Z",
              payload: "{}",
            },
          },
        ],
      },
    ]);

    await module.initAgentEventStream();
    const entries = await module.readAgentEventBacklog("agent-legacy", "$");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventId).toBe("legacy");
  });

  it("ack drops the listed stream ids via XDEL", async () => {
    const { module, client } = await setupModule();
    client.xDel.mockResolvedValue(2);

    await module.initAgentEventStream();
    await module.ackAgentEventFrames("agent-ack", ["1-0", "2-0"]);

    expect(client.xDel).toHaveBeenCalledWith("plug_agent_stream:{plug}:agent-ack", ["1-0", "2-0"]);
  });

  it("ack is a no-op when given an empty array", async () => {
    const { module, client } = await setupModule();

    await module.initAgentEventStream();
    await module.ackAgentEventFrames("agent-empty", []);

    expect(client.xDel).not.toHaveBeenCalled();
  });

  it("init falls back to in-memory when connect fails", async () => {
    const { module, client } = await setupModule();
    client.connect.mockRejectedValueOnce(new Error("redis unavailable"));

    await module.initAgentEventStream();
    expect(module.isAgentEventStreamActive()).toBe(false);

    const id = await module.appendAgentEventFrame("agent-x", {
      eventId: "e",
      eventName: "x",
      emittedAt: "2026-01-01T00:00:00.000Z",
      payload: "{}",
    });
    expect(id).toBeUndefined();
  });

  it("init skips when AGENT_EVENT_STREAM_ENABLED=false", async () => {
    const { module, createClientMock } = await setupModule({ enabled: false });

    await module.initAgentEventStream();

    expect(createClientMock).not.toHaveBeenCalled();
    expect(module.isAgentEventStreamActive()).toBe(false);
  });

  it("consumer-groups path: ensures group with MKSTREAM and reads via XREADGROUP", async () => {
    const { module, client } = await setupModule({ useConsumerGroups: true });
    // ensureConsumerGroup XGROUP CREATE -> first sendCommand.
    client.sendCommand.mockImplementation(async (args: unknown) => {
      if (Array.isArray(args) && args[0] === "XGROUP" && args[1] === "CREATE") {
        return "OK";
      }
      if (Array.isArray(args) && args[0] === "XREADGROUP") {
        return [
          [
            "plug_agent_stream:{plug}:agent-cg",
            [
              [
                "111-0",
                [
                  "schemaVersion",
                  "1",
                  "eventId",
                  "evt-cg",
                  "eventName",
                  "client:custom.x",
                  "emittedAt",
                  "2026-01-01T00:00:00.000Z",
                  "payload",
                  "{}",
                ],
              ],
            ],
          ],
        ];
      }
      return undefined;
    });

    await module.initAgentEventStream();
    const entries = await module.readAgentEventBacklog("agent-cg", "$");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventId).toBe("evt-cg");
    const xgroupCalls = client.sendCommand.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[0] === "XGROUP",
    );
    const xreadgroupCalls = client.sendCommand.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[0] === "XREADGROUP",
    );
    expect(xgroupCalls).toHaveLength(1);
    expect(xreadgroupCalls).toHaveLength(1);
  });

  it("consumer-groups path: ack uses XACK instead of XDEL", async () => {
    const { module, client } = await setupModule({ useConsumerGroups: true });
    client.sendCommand.mockResolvedValue(2);

    await module.initAgentEventStream();
    await module.ackAgentEventFrames("agent-cg", ["1-0", "2-0"]);

    const xackCalls = client.sendCommand.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[0] === "XACK",
    );
    expect(xackCalls).toHaveLength(1);
    expect(client.xDel).not.toHaveBeenCalled();
  });

  it("consumer-groups path: BUSYGROUP error from XGROUP CREATE is swallowed", async () => {
    const { module, client } = await setupModule({ useConsumerGroups: true });
    client.sendCommand.mockImplementation(async (args: unknown) => {
      if (Array.isArray(args) && args[0] === "XGROUP" && args[1] === "CREATE") {
        throw new Error("BUSYGROUP Consumer Group name already exists");
      }
      if (Array.isArray(args) && args[0] === "XREADGROUP") {
        return null;
      }
      return undefined;
    });

    await module.initAgentEventStream();
    const entries = await module.readAgentEventBacklog("agent-cg-busy", "$");
    expect(entries).toHaveLength(0);
  });

  it("init skips when URL is empty", async () => {
    const { module, createClientMock } = await setupModule({ url: "" });

    await module.initAgentEventStream();

    expect(createClientMock).not.toHaveBeenCalled();
  });

  describe("appendAgentEventFramesBatch", () => {
    const baseFrame = {
      eventId: "evt-1",
      eventName: "client:custom.test",
      emittedAt: "2026-01-01T00:00:00.000Z",
      payload: '{"x":1}',
    } as const;

    it("returns [] for empty input without touching the client", async () => {
      const { module, client } = await setupModule();
      await module.initAgentEventStream();

      const out = await module.appendAgentEventFramesBatch([]);

      expect(out).toEqual([]);
      expect(client.multi).not.toHaveBeenCalled();
    });

    it("issues a single MULTI/EXEC for N entries (XADD + PEXPIRE per entry)", async () => {
      const { module, client, multiCalls, multiExecMock } = await setupModule({
        ttlMs: 60_000,
      });
      multiExecMock.mockResolvedValue(["100-0", 1, "200-0", 1, "300-0", 1]);

      await module.initAgentEventStream();
      const out = await module.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame },
        { principalId: "agent-b", frame: baseFrame },
        { principalId: "agent-c", frame: baseFrame },
      ]);

      expect(out).toEqual(["100-0", "200-0", "300-0"]);
      expect(client.multi).toHaveBeenCalledTimes(1);
      const xaddCalls = multiCalls.filter((c) => c.method === "xAdd");
      const pexpireCalls = multiCalls.filter((c) => c.method === "pExpire");
      expect(xaddCalls).toHaveLength(3);
      expect(pexpireCalls).toHaveLength(3);
      expect(xaddCalls[0]?.args[0]).toBe("plug_agent_stream:{plug}:agent-a");
      expect(xaddCalls[1]?.args[0]).toBe("plug_agent_stream:{plug}:agent-b");
      expect(xaddCalls[2]?.args[0]).toBe("plug_agent_stream:{plug}:agent-c");
    });

    it("omits PEXPIRE when TTL is disabled", async () => {
      const { module, multiCalls, multiExecMock } = await setupModule({ ttlMs: 0 });
      multiExecMock.mockResolvedValue(["100-0", "200-0"]);

      await module.initAgentEventStream();
      await module.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame },
        { principalId: "agent-b", frame: baseFrame },
      ]);

      expect(multiCalls.every((c) => c.method === "xAdd")).toBe(true);
      expect(multiCalls).toHaveLength(2);
    });

    it("filters non-allowlisted principals and aligns results 1:1 with input", async () => {
      const { multiCalls, multiExecMock } = await setupModule({ ttlMs: 0 });
      // Override env to set an allowlist (replaces the module imported above).
      vi.resetModules();
      vi.doMock("../../../../src/shared/config/env", () => ({
        env: {
          agentEventStreamRedisUrl: "redis://localhost:6379",
          agentEventStreamEnabled: true,
          agentEventStreamMaxLen: 100,
          agentEventStreamTtlMs: 0,
          agentEventStreamBacklogMaxEntries: 50,
          agentEventStreamAgentAllowlist: ["agent-a", "agent-c"],
          agentEventStreamDrainAckTimeoutMs: 1_000,
          agentEventStreamUseConsumerGroups: false,
          agentEventStreamConsumerGroup: "plug_hub",
          hubInstanceId: "test-replica",
          redisDefaultConnectTimeoutMs: 5_000,
          redisTenantId: "",
          redisDefaultReconnectBaseMs: 200,
          redisDefaultReconnectMaxMs: 5_000,
        },
      }));
      vi.doMock("redis", () => ({
        createClient: () => ({
          on: vi.fn().mockReturnThis(),
          connect: vi.fn().mockResolvedValue(undefined),
          quit: vi.fn().mockResolvedValue(undefined),
          ping: vi.fn().mockResolvedValue("PONG"),
          xAdd: vi.fn(),
          xRead: vi.fn(),
          xDel: vi.fn(),
          pExpire: vi.fn(),
          sendCommand: vi.fn(),
          multi: () => {
            multiCalls.length = 0;
            return {
              xAdd: vi.fn(function (this: unknown, ...args: unknown[]) {
                multiCalls.push({ method: "xAdd", args });
                return this;
              }),
              pExpire: vi.fn(),
              exec: multiExecMock,
            };
          },
        }),
      }));
      const reloaded = await import("../../../../src/infrastructure/redis/agent_event_stream");
      multiExecMock.mockResolvedValue(["100-0", "300-0"]);
      await reloaded.initAgentEventStream();

      const out = await reloaded.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame }, // allowed
        { principalId: "agent-b", frame: baseFrame }, // not in allowlist
        { principalId: "agent-c", frame: baseFrame }, // allowed
      ]);

      expect(out).toEqual(["100-0", undefined, "300-0"]);
      const xaddCalls = multiCalls.filter((c) => c.method === "xAdd");
      expect(xaddCalls).toHaveLength(2);
      expect(xaddCalls[0]?.args[0]).toBe("plug_agent_stream:{plug}:agent-a");
      expect(xaddCalls[1]?.args[0]).toBe("plug_agent_stream:{plug}:agent-c");
    });

    it("treats per-entry rejected replies as partial failures", async () => {
      const { module, multiExecMock } = await setupModule({ ttlMs: 0 });
      // Second XADD reply is null (rejected by server inside an otherwise-successful EXEC).
      multiExecMock.mockResolvedValue(["100-0", null, "300-0"]);

      await module.initAgentEventStream();
      const out = await module.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame },
        { principalId: "agent-b", frame: baseFrame },
        { principalId: "agent-c", frame: baseFrame },
      ]);

      expect(out).toEqual(["100-0", undefined, "300-0"]);
    });

    it("treats EXEC throw as a global failure: returns undefined for every entry", async () => {
      const { module, multiExecMock } = await setupModule({ ttlMs: 0 });
      multiExecMock.mockRejectedValue(new Error("connection lost"));

      await module.initAgentEventStream();
      const out = await module.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame },
        { principalId: "agent-b", frame: baseFrame },
      ]);

      expect(out).toEqual([undefined, undefined]);
    });

    it("returns all-undefined when client is not connected", async () => {
      const { module, client } = await setupModule();
      // Don't init: redisClient stays undefined.
      const out = await module.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame },
      ]);
      expect(out).toEqual([undefined]);
      expect(client.multi).not.toHaveBeenCalled();
    });

    it("returns all-undefined when stream feature is disabled", async () => {
      const { module, client } = await setupModule({ enabled: false });
      await module.initAgentEventStream();

      const out = await module.appendAgentEventFramesBatch([
        { principalId: "agent-a", frame: baseFrame },
      ]);
      expect(out).toEqual([undefined]);
      expect(client.multi).not.toHaveBeenCalled();
    });
  });
});
