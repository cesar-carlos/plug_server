import type { RegisteredAgent } from "../../socket/hub/agent_registry";

/**
 * Public-facing projection of a connected agent for HTTP responses.
 *
 * Hides internal Socket.IO `socketId` (Engine.IO id) — clients should never
 * need it and exposing it leaks transport-layer detail that can be used to
 * target specific connections from other replicas/log scrapers.
 */
export interface PublicConnectedAgent {
  readonly agentId: string;
  readonly userId: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: string;
  readonly lastSeenAt: string;
}

export const toPublicConnectedAgent = (agent: RegisteredAgent): PublicConnectedAgent => ({
  agentId: agent.agentId,
  userId: agent.userId,
  capabilities: agent.capabilities,
  connectedAt: agent.connectedAt,
  lastSeenAt: agent.lastSeenAt,
});

export const toPublicConnectedAgents = (
  agents: readonly RegisteredAgent[],
): PublicConnectedAgent[] => agents.map(toPublicConnectedAgent);
