import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRegistry } from "../../../../src/presentation/socket/hub/registries/agent_registry";

import type { AgentCommandDispatcher } from "../../../../src/application/agent_commands/execute_agent_command";
import { RestAgentBridgeService } from "../../../../src/application/services/rest_agent_bridge.service";
import type { IAgentsHubDiagnosticsPort } from "../../../../src/domain/ports/agents_hub_diagnostics.port";
import type {
  ConnectedAgentSnapshot,
  IConnectedAgentsRegistryPort,
} from "../../../../src/domain/ports/connected_agents_registry.port";

describe("RestAgentBridgeService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    agentRegistry.clear();
  });

  it("should project only visible connected agents in registry order and reflect disconnects", () => {
    for (let i = 0; i < 1000; i += 1)
      agentRegistry.upsert({
        agentId: `agent-${i}`,
        socketId: `socket-${i}`,
        userId: null,
        capabilities: {},
      });
    const registry: IConnectedAgentsRegistryPort = {
      listAll: () => agentRegistry.listAll(),
      listIds: () => agentRegistry.listIds(),
      listPage: (options) => agentRegistry.listPage(options),
      isConnected: (id) => agentRegistry.isRegistered(id),
      findById: (id) => agentRegistry.findByAgentId(id),
    };
    const service = new RestAgentBridgeService(
      registry,
      { getAgentsNamespaceConnectionCount: () => 1000 },
      vi.fn() as AgentCommandDispatcher,
    );
    const allowed = new Set(["agent-99", "offline", "agent-3"]);
    const expected = agentRegistry.listAll().filter((agent) => allowed.has(agent.agentId));
    const iso = vi.spyOn(Date.prototype, "toISOString");
    expect(service.listConnectedAgents(allowed)).toEqual(expected);
    expect(iso).toHaveBeenCalledTimes(2);
    iso.mockClear();
    expect(service.listConnectedAgents(new Set())).toEqual([]);
    expect(iso).not.toHaveBeenCalled();
    agentRegistry.removeBySocketId("socket-3");
    expect(service.listConnectedAgents(allowed).map((agent) => agent.agentId)).toEqual([
      "agent-99",
    ]);
    expect(service.listConnectedAgents()).toHaveLength(999);
  });

  it("should delegate connected agent listing and dispatch to injected ports", () => {
    const agents: ConnectedAgentSnapshot[] = [
      {
        agentId: "agent-1",
        userId: "user-1",
        capabilities: {},
        connectedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
      },
    ];
    const registry: IConnectedAgentsRegistryPort = {
      listAll: vi.fn(() => agents),
      listIds: vi.fn(() => agents.map((agent) => agent.agentId)),
      listPage: vi.fn(() => ({ items: agents, total: agents.length })),
      findById: vi.fn((id) => agents.find((agent) => agent.agentId === id) ?? null),
      isConnected: vi.fn((agentId: string) => agentId === "agent-1"),
    };
    const diagnostics: IAgentsHubDiagnosticsPort = {
      getAgentsNamespaceConnectionCount: vi.fn(() => 4),
    };
    const dispatch = vi.fn() as AgentCommandDispatcher;

    const service = new RestAgentBridgeService(registry, diagnostics, dispatch);

    expect(service.listConnectedAgents()).toEqual(agents);
    expect(service.isAgentConnected("agent-1")).toBe(true);
    expect(service.isAgentConnected("agent-2")).toBe(false);
    expect(service.getAgentsNamespaceConnectionCount()).toBe(4);
    expect(service.getDispatchCommand()).toBe(dispatch);
    expect(service.sqlOperationCapabilities("agent-1")).toBeNull();
    expect(service.sqlOperationCapabilities("absent")).toBeNull();
    agents[0]!.capabilities.extensions = {
      sqlOperations: {
        enabled: true,
        version: 1,
        durableJournal: true,
        singleSourceTransaction: true,
        automaticReplay: false,
        maxSteps: 100,
        maxAffectedRows: 12,
        timeoutMs: 9000,
      },
    };
    expect(service.sqlOperationCapabilities("agent-1")).toEqual({
      version: 1,
      maxSteps: 32,
      maxAffectedRows: 12,
      timeoutMs: 9000,
    });
    agents[0]!.capabilities.extensions = { sqlOperations: { enabled: false, version: 1 } };
    expect(service.sqlOperationCapabilities("agent-1")).toBeNull();
    for (const version of [1, 2, null]) {
      agents[0]!.capabilities.extensions = { sourceSchema: version, sourceConstraints: version };
      expect(service.sourceSchemaCapability("agent-1")).toBe(version === 1 ? 1 : null);
      expect(service.sourceConstraintsCapability("agent-1")).toBe(version === 1 ? 1 : null);
    }
    agents[0]!.capabilities.extensions = { sourceSchema: 1, sourceConstraints: 1 };
    agents.length = 0;
    expect(service.sourceSchemaCapability("agent-1")).toBeNull();
    expect(service.sourceConstraintsCapability("agent-1")).toBeNull();
  });
});
