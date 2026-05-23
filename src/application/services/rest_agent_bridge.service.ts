import type { AgentCommandDispatcher } from "../agent_commands/execute_agent_command";
import type { IAgentsHubDiagnosticsPort } from "../../domain/ports/agents_hub_diagnostics.port";
import type {
  ConnectedAgentSnapshot,
  IConnectedAgentsRegistryPort,
} from "../../domain/ports/connected_agents_registry.port";

export class RestAgentBridgeService {
  constructor(
    private readonly connectedAgentsRegistry: IConnectedAgentsRegistryPort,
    private readonly hubDiagnostics: IAgentsHubDiagnosticsPort,
    private readonly dispatchCommand: AgentCommandDispatcher,
  ) {}

  listConnectedAgents(): readonly ConnectedAgentSnapshot[] {
    return this.connectedAgentsRegistry.listAll();
  }

  isAgentConnected(agentId: string): boolean {
    return this.connectedAgentsRegistry.isConnected(agentId);
  }

  getAgentsNamespaceConnectionCount(): number | undefined {
    return this.hubDiagnostics.getAgentsNamespaceConnectionCount();
  }

  getDispatchCommand(): AgentCommandDispatcher {
    return this.dispatchCommand;
  }
}
