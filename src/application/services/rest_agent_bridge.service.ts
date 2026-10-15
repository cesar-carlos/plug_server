import { negotiateSqlOperations } from "../../shared/constants/sql_operation_transport";
import { isRecord } from "../../shared/utils/rpc_types";
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

  /** Local live registration only. Dispatch repeats negotiation immediately before emit. */
  sqlOperationCapabilities(agentId: string): {
    version: 1;
    structureGuard?: 1;
    maxSteps: number;
    maxAffectedRows: number;
    timeoutMs: number;
  } | null {
    const capabilities = this.connectedAgentsRegistry.findById(agentId)?.capabilities;
    const extensions =
      capabilities && isRecord(capabilities.extensions) ? capabilities.extensions : null;
    const limits = negotiateSqlOperations(extensions?.sqlOperations);
    return limits ? { version: 1 as const, ...limits } : null;
  }

  sourceIdentityCapability(agentId: string): 1 | null {
    return this.sourceCapability(agentId, "sourceIdentity");
  }

  sourceSchemaCapability(agentId: string): 1 | null {
    return this.sourceCapability(agentId, "sourceSchema");
  }

  sourceConstraintsCapability(agentId: string): 1 | null {
    return this.sourceCapability(agentId, "sourceConstraints");
  }

  private sourceCapability(
    agentId: string,
    name: "sourceIdentity" | "sourceSchema" | "sourceConstraints",
  ): 1 | null {
    const caps = this.connectedAgentsRegistry.findById(agentId)?.capabilities;
    return caps && isRecord(caps.extensions) && caps.extensions[name] === 1 ? 1 : null;
  }

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
