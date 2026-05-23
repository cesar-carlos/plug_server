import type { IAgentsHubDiagnosticsPort } from "../../domain/ports/agents_hub_diagnostics.port";
import type {
  ConnectedAgentSnapshot,
  IConnectedAgentsRegistryPort,
} from "../../domain/ports/connected_agents_registry.port";
import { agentsNamespace } from "../../socket";
import { agentRegistry } from "../socket/hub/agent_registry";

export const connectedAgentsRegistryAdapter: IConnectedAgentsRegistryPort = {
  listAll(): readonly ConnectedAgentSnapshot[] {
    return agentRegistry.listAll().map(
      ({ agentId, userId, capabilities, connectedAt, lastSeenAt }): ConnectedAgentSnapshot => ({
        agentId,
        userId,
        capabilities,
        connectedAt,
        lastSeenAt,
      }),
    );
  },
  isConnected(agentId: string): boolean {
    return agentRegistry.findByAgentId(agentId) !== null;
  },
};

export const agentsHubDiagnosticsAdapter: IAgentsHubDiagnosticsPort = {
  getAgentsNamespaceConnectionCount(): number | undefined {
    return agentsNamespace?.sockets.size;
  },
};
