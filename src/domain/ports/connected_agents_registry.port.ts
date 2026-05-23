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
}
