import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  hubInstanceId: "hub-local",
  agentHubBridgeForwardTimeoutMs: 30_000,
  agentHubClusterInstanceIds: [] as string[],
}));

vi.mock("../../../../src/shared/config/env", () => ({
  env: mockEnv,
}));

import {
  createDispatchOrForwardRpcCommand,
  type AgentHubBridgeForwardDeps,
} from "../../../../src/application/services/agent_hub_bridge_forward.service";
import { AgentDisconnectedBeforeDispatchError } from "../../../../src/shared/errors/agent_disconnected_before_dispatch.error";
import { notFound } from "../../../../src/shared/errors/http_errors";

const buildDeps = (
  overrides: Partial<AgentHubBridgeForwardDeps> = {},
): AgentHubBridgeForwardDeps => ({
  presence: {
    isEnabled: true,
    upsert: vi.fn(),
    touch: vi.fn(),
    removeIfSocketMatches: vi.fn(),
    removeIfHubInstanceMatches: vi.fn(),
    resolveRoute: vi.fn().mockResolvedValue({ hubInstanceId: "hub-remote" }),
  },
  isAgentRegisteredLocally: vi.fn().mockReturnValue(false),
  hasKnownAgentId: vi.fn().mockReturnValue(true),
  localDispatch: vi.fn().mockResolvedValue({
    requestId: "req-1",
    response: { ok: true },
  }),
  publishCommand: vi.fn().mockResolvedValue(true),
  publishReply: vi.fn().mockResolvedValue(true),
  waitForReply: vi.fn().mockResolvedValue(
    JSON.stringify({
      kind: "success",
      result: { requestId: "fwd-1", response: { forwarded: true } },
    }),
  ),
  onBridgeCommand: vi.fn(),
  ...overrides,
});

describe("createDispatchOrForwardRpcCommand", () => {
  it("dispatches locally when the agent is on this replica", async () => {
    const localDispatch = vi.fn().mockResolvedValue({ requestId: "local", response: {} });
    const dispatch = createDispatchOrForwardRpcCommand(
      buildDeps({
        isAgentRegisteredLocally: vi.fn().mockReturnValue(true),
        localDispatch,
      }),
    );

    await dispatch({
      agentId: "agent-1",
      command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
    });

    expect(localDispatch).toHaveBeenCalledOnce();
  });

  it("forwards to the owning hub when presence routes elsewhere", async () => {
    const deps = buildDeps();
    const dispatch = createDispatchOrForwardRpcCommand(deps);

    const result = await dispatch({
      agentId: "agent-1",
      command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
    });

    expect(deps.publishCommand).toHaveBeenCalledWith("hub-remote", expect.any(String));
    expect(result).toEqual({ requestId: "fwd-1", response: { forwarded: true } });
  });

  it("throws agent_offline when known agent has no presence route", async () => {
    const dispatch = createDispatchOrForwardRpcCommand(
      buildDeps({
        presence: {
          isEnabled: true,
          upsert: vi.fn(),
          touch: vi.fn(),
          removeIfSocketMatches: vi.fn(),
          removeIfHubInstanceMatches: vi.fn(),
          resolveRoute: vi.fn().mockResolvedValue(null),
        },
        hasKnownAgentId: vi.fn().mockReturnValue(true),
      }),
    );

    await expect(
      dispatch({
        agentId: "agent-1",
        command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
      }),
    ).rejects.toBeInstanceOf(AgentDisconnectedBeforeDispatchError);
  });

  it("clears stale local presence and forwards when the agent moved to another hub", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({ hubInstanceId: "hub-local" })
      .mockResolvedValueOnce({ hubInstanceId: "hub-remote" });
    const deps = buildDeps({
      presence: {
        isEnabled: true,
        upsert: vi.fn(),
        touch: vi.fn(),
        removeIfSocketMatches: vi.fn(),
        removeIfHubInstanceMatches: vi.fn(),
        resolveRoute,
      },
      isAgentRegisteredLocally: vi.fn().mockReturnValue(false),
    });
    const dispatch = createDispatchOrForwardRpcCommand(deps);

    await dispatch({
      agentId: "agent-1",
      command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
    });

    expect(deps.presence.removeIfHubInstanceMatches).toHaveBeenCalledWith("agent-1", "hub-local");
    expect(deps.publishCommand).toHaveBeenCalledWith("hub-remote", expect.any(String));
  });

  it("throws agent_offline when stale local presence cannot be re-routed", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({ hubInstanceId: "hub-local" })
      .mockResolvedValue(null);
    const dispatch = createDispatchOrForwardRpcCommand(
      buildDeps({
        presence: {
          isEnabled: true,
          upsert: vi.fn(),
          touch: vi.fn(),
          removeIfSocketMatches: vi.fn(),
          removeIfHubInstanceMatches: vi.fn(),
          resolveRoute,
        },
        isAgentRegisteredLocally: vi.fn().mockReturnValue(false),
        hasKnownAgentId: vi.fn().mockReturnValue(true),
      }),
    );

    await expect(
      dispatch({
        agentId: "agent-1",
        command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
      }),
    ).rejects.toBeInstanceOf(AgentDisconnectedBeforeDispatchError);
  });

  it("forwards to a cluster peer when presence has no route", async () => {
    mockEnv.agentHubClusterInstanceIds = ["hub-local", "hub-peer"];
    const deps = buildDeps({
      presence: {
        isEnabled: true,
        upsert: vi.fn(),
        touch: vi.fn(),
        removeIfSocketMatches: vi.fn(),
        removeIfHubInstanceMatches: vi.fn(),
        resolveRoute: vi.fn().mockResolvedValue(null),
      },
    });
    const dispatch = createDispatchOrForwardRpcCommand(deps);

    const result = await dispatch({
      agentId: "agent-1",
      command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
    });

    expect(deps.publishCommand).toHaveBeenCalledWith("hub-peer", expect.any(String));
    expect(result).toEqual({ requestId: "fwd-1", response: { forwarded: true } });
    mockEnv.agentHubClusterInstanceIds = [];
  });

  it("throws not found for unknown agents without a route", async () => {
    const dispatch = createDispatchOrForwardRpcCommand(
      buildDeps({
        presence: {
          isEnabled: true,
          upsert: vi.fn(),
          touch: vi.fn(),
          removeIfSocketMatches: vi.fn(),
          removeIfHubInstanceMatches: vi.fn(),
          resolveRoute: vi.fn().mockResolvedValue(null),
        },
        hasKnownAgentId: vi.fn().mockReturnValue(false),
      }),
    );

    await expect(
      dispatch({
        agentId: "agent-unknown",
        command: { jsonrpc: "2.0", method: "sql.execute", id: "1", params: {} },
      }),
    ).rejects.toMatchObject(notFound("Agent agent-unknown"));
  });
});
