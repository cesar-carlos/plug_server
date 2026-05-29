export interface AgentHubPresenceRecord {
  readonly hubInstanceId: string;
  readonly socketId: string;
  readonly connectedAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface AgentHubPresenceRoute {
  readonly hubInstanceId: string;
}

export interface AgentHubPresencePort {
  readonly isEnabled: boolean;
  upsert(
    agentId: string,
    record: Omit<AgentHubPresenceRecord, "lastSeenAtMs"> & { readonly lastSeenAtMs?: number },
  ): Promise<void>;
  touch(agentId: string): Promise<void>;
  removeIfSocketMatches(agentId: string, socketId: string): Promise<void>;
  /** Clears presence when it still names this hub but the socket is gone (stale route). */
  removeIfHubInstanceMatches(agentId: string, hubInstanceId: string): Promise<void>;
  resolveRoute(agentId: string): Promise<AgentHubPresenceRoute | null>;
}
