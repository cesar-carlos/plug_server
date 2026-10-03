import type { AgentCommandDispatcher } from "../agent_commands/execute_agent_command";
import type { IAgentsHubDiagnosticsPort } from "../../domain/ports/agents_hub_diagnostics.port";
import type {
  ConnectedAgentSnapshot,
  IConnectedAgentsRegistryPort,
} from "../../domain/ports/connected_agents_registry.port";

export type { ConnectedAgentSnapshot };

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

  /** Cluster-aware connectivity when {@link isAgentConnectedToHub} is injected. */
  isAgentConnectedCluster?: (agentId: string) => Promise<boolean>;

  resolveClusterConnectedAgentIds?: (agentIds: readonly string[]) => Promise<ReadonlySet<string>>;

  /**
   * Returns a Set of all currently connected agent IDs in O(N) time.
   * Use when checking connectivity for multiple agents in a single request
   * to avoid O(N²) individual `isAgentConnected` calls per page of results.
   */
  getConnectedAgentIdSet(): ReadonlySet<string> {
    return new Set(this.connectedAgentsRegistry.listIds());
  }

  /** Projects only the visible page; registry membership checks do not create DTOs. */
  listConnectedAgentsPaged(options: {
    readonly allowedIds?: ReadonlySet<string>;
    readonly page: number;
    readonly pageSize: number;
  }): {
    readonly items: readonly ConnectedAgentSnapshot[];
    readonly total: number;
  } {
    return this.connectedAgentsRegistry.listPage(options);
  }

  getAgentsNamespaceConnectionCount(): number | undefined {
    return this.hubDiagnostics.getAgentsNamespaceConnectionCount();
  }

  getDispatchCommand(): AgentCommandDispatcher {
    return this.dispatchCommand;
  }
}
