import { afterEach, describe, expect, it } from "vitest";

import { agentRegistry } from "../../../../../src/presentation/socket/hub/agent_registry";

describe("agent_registry session policies", () => {
  afterEach(() => {
    agentRegistry.clear();
  });

  it("reject_active blocks when peer socket is connected", () => {
    const alive = new Set(["sock-a"]);
    const first = agentRegistry.registerAgentSession({
      agentId: "ag-r",
      socketId: "sock-a",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: (sid) => alive.has(sid),
    });
    expect(first.ok).toBe(true);

    const second = agentRegistry.registerAgentSession({
      agentId: "ag-r",
      socketId: "sock-b",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: (sid) => alive.has(sid),
    });
    expect(second).toEqual({ ok: false, reason: "SESSION_ACTIVE" });
    expect(agentRegistry.findByAgentId("ag-r")?.socketId).toBe("sock-a");
  });

  it("reject_active allows replacement when peer is not connected", () => {
    const first = agentRegistry.registerAgentSession({
      agentId: "ag-dead",
      socketId: "sock-old",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: () => false,
    });
    expect(first.ok).toBe(true);

    const second = agentRegistry.registerAgentSession({
      agentId: "ag-dead",
      socketId: "sock-new",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: () => false,
    });
    expect(second.ok).toBe(true);
    expect(agentRegistry.findByAgentId("ag-dead")?.socketId).toBe("sock-new");
  });

  it("takeover_disconnect_previous returns replacedSocketId when peer alive", () => {
    const alive = new Set(["sock-1"]);
    agentRegistry.registerAgentSession({
      agentId: "ag-t",
      socketId: "sock-1",
      userId: "u1",
      capabilities: {},
      policy: "takeover_disconnect_previous",
      isPeerConnected: (sid) => alive.has(sid),
    });

    const next = agentRegistry.registerAgentSession({
      agentId: "ag-t",
      socketId: "sock-2",
      userId: "u1",
      capabilities: {},
      policy: "takeover_disconnect_previous",
      isPeerConnected: (sid) => alive.has(sid),
    });
    expect(next.ok).toBe(true);
    if (!next.ok) {
      throw new Error("unexpected");
    }
    expect(next.replacedSocketId).toBe("sock-1");
    expect(agentRegistry.findByAgentId("ag-t")?.socketId).toBe("sock-2");
  });

  it("sync registration blocks reject_active race via single synchronous path", () => {
    const alive = new Set(["s1"]);
    agentRegistry.registerAgentSession({
      agentId: "race",
      socketId: "s1",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: (sid) => alive.has(sid),
    });

    const r2 = agentRegistry.registerAgentSession({
      agentId: "race",
      socketId: "s2",
      userId: "u1",
      capabilities: {},
      policy: "reject_active",
      isPeerConnected: (sid) => alive.has(sid),
    });
    expect(r2).toEqual({ ok: false, reason: "SESSION_ACTIVE" });
  });
});

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

  it("rejects replacing a connected agent owned by another user", () => {
    const first = agentRegistry.upsert({
      agentId: "agent-owned",
      socketId: "socket-1",
      userId: "user-1",
      capabilities: {},
    });
    expect(first.ok).toBe(true);

    const second = agentRegistry.upsert({
      agentId: "agent-owned",
      socketId: "socket-2",
      userId: "user-2",
      capabilities: {},
    });

    expect(second).toEqual({ ok: false, reason: "OWNED_BY_ANOTHER_USER" });
    expect(agentRegistry.findByAgentId("agent-owned")?.socketId).toBe("socket-1");
  });

  it("only touches liveness when the caller socket is canonical", () => {
    agentRegistry.upsert({
      agentId: "agent-touch",
      socketId: "socket-current",
      userId: "user-1",
      capabilities: {},
    });

    expect(agentRegistry.touch("agent-touch", { socketId: "socket-stale" })).toBeNull();
    expect(agentRegistry.touch("agent-touch", { socketId: "socket-current" })?.agentId).toBe(
      "agent-touch",
    );
  });
});
