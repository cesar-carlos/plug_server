export interface ConnectedAgentSnapshot {
  readonly agentId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

export interface IConnectedAgentsRegistryPort {
  listAll(): readonly ConnectedAgentSnapshot[];
  isConnected(agentId: string): boolean;
  /**
   * Returns the snapshot for a single agent, or `null` if not connected.
   * Enables O(1) registry membership checks when iterating a small `allowedIds` set
   * rather than O(N) scans over the full connected-agent list.
   */
  findById(agentId: string): ConnectedAgentSnapshot | null;
}
