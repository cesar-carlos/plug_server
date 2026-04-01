/**
 * Port for checking realtime agent connection relative to a user account
 * (used for self-service agent binding).
 */
export type AgentPresenceForUser =
  | { kind: "online_same_user" }
  | { kind: "offline" }
  | { kind: "online_other_user" };

export interface AgentOnlinePresencePort {
  resolvePresenceForUser(agentId: string, userId: string): Promise<AgentPresenceForUser>;
}
