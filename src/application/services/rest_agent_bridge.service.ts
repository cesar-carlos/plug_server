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

  resolveClusterConnectedAgentIds?: (
    agentIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;

  /**
   * Returns a Set of all currently connected agent IDs in O(N) time.
   * Use when checking connectivity for multiple agents in a single request
   * to avoid O(N²) individual `isAgentConnected` calls per page of results.
   */
  getConnectedAgentIdSet(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const agent of this.connectedAgentsRegistry.listAll()) {
      ids.add(agent.agentId);
    }
    return ids;
  }

  /**
   * Returns a paginated slice of connected agents with an optional visibility filter.
   *
   * **Admin path** (`allowedIds === undefined`): O(N) scan over all connected agents,
   * unavoidable since we must know the total count for pagination.
   *
   * **Non-admin path** (`allowedIds` is a Set): O(|allowedIds|) — iterates the caller's
   * small set of accessible agent IDs and does O(1) registry lookups per item.
   * This avoids an O(N_all) full-registry scan when the user can only see a small subset.
   */
  listConnectedAgentsPaged(options: {
    readonly allowedIds?: ReadonlySet<string>;
    readonly page: number;
    readonly pageSize: number;
  }): {
    readonly items: readonly ConnectedAgentSnapshot[];
    readonly total: number;
  } {
    const { allowedIds, page, pageSize } = options;
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(100, pageSize));
    const start = (safePage - 1) * safePageSize;

    if (allowedIds !== undefined) {
      const visible: ConnectedAgentSnapshot[] = [];
      for (const agentId of allowedIds) {
        const snapshot = this.connectedAgentsRegistry.findById(agentId);
        if (snapshot !== null) {
          visible.push(snapshot);
        }
      }
      const total = visible.length;
      return { items: visible.slice(start, start + safePageSize), total };
    }

    const all = this.connectedAgentsRegistry.listAll();
    const total = all.length;
    return { items: all.slice(start, start + safePageSize), total };
  }

  getAgentsNamespaceConnectionCount(): number | undefined {
    return this.hubDiagnostics.getAgentsNamespaceConnectionCount();
  }

  getDispatchCommand(): AgentCommandDispatcher {
    return this.dispatchCommand;
  }
}
