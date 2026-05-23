import { describe, expect, it, vi } from "vitest";

import type { AgentCommandDispatcher } from "../../../../src/application/agent_commands/execute_agent_command";
import { RestAgentBridgeService } from "../../../../src/application/services/rest_agent_bridge.service";
import type { IAgentsHubDiagnosticsPort } from "../../../../src/domain/ports/agents_hub_diagnostics.port";
import type {
  ConnectedAgentSnapshot,
  IConnectedAgentsRegistryPort,
} from "../../../../src/domain/ports/connected_agents_registry.port";

describe("RestAgentBridgeService", () => {
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
  });
});
