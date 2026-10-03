export interface ConnectedAgentSnapshot {
  readonly agentId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

export interface IConnectedAgentsRegistryPort {
  listIds(): readonly string[];
  listPage(options: {
    readonly allowedIds?: ReadonlySet<string>;
    readonly page: number;
    readonly pageSize: number;
  }): { readonly items: readonly ConnectedAgentSnapshot[]; readonly total: number };
  listAll(): readonly ConnectedAgentSnapshot[];
  isConnected(agentId: string): boolean;
  /**
   * Returns the snapshot for a single agent, or `null` if not connected.
   * Enables O(1) registry membership checks when iterating a small `allowedIds` set
   * rather than O(N) scans over the full connected-agent list.
   */
  findById(agentId: string): ConnectedAgentSnapshot | null;
}
