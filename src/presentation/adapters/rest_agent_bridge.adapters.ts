import type { IAgentsHubDiagnosticsPort } from "../../domain/ports/agents_hub_diagnostics.port";
import type {
  ConnectedAgentSnapshot,
  IConnectedAgentsRegistryPort,
} from "../../domain/ports/connected_agents_registry.port";
import { agentsNamespace } from "../../socket";
import { agentRegistry } from "../socket/hub/agent_registry";

const toSnapshot = ({
  agentId,
  userId,
  capabilities,
  connectedAt,
  lastSeenAt,
}: {
  agentId: string;
  userId: string | null;
  capabilities: Record<string, unknown>;
  connectedAt: string;
  lastSeenAt: string;
}): ConnectedAgentSnapshot => ({ agentId, userId, capabilities, connectedAt, lastSeenAt });

export const connectedAgentsRegistryAdapter: IConnectedAgentsRegistryPort = {
  listAll(): readonly ConnectedAgentSnapshot[] {
    return agentRegistry.listAll().map(toSnapshot);
  },
  isConnected(agentId: string): boolean {
    return agentRegistry.findByAgentId(agentId) !== null;
  },
  findById(agentId: string): ConnectedAgentSnapshot | null {
    const agent = agentRegistry.findByAgentId(agentId);
    return agent !== null ? toSnapshot(agent) : null;
  },
};

export const agentsHubDiagnosticsAdapter: IAgentsHubDiagnosticsPort = {
  getAgentsNamespaceConnectionCount(): number | undefined {
    return agentsNamespace?.sockets.size;
  },
};
