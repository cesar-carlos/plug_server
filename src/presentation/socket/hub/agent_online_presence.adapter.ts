import type {
  AgentOnlinePresencePort,
  AgentPresenceForUser,
} from "../../../application/ports/agent_online_presence.port";
import { agentRegistry } from "./agent_registry";

/** Bridges {@link AgentOnlinePresencePort} to the in-memory {@link agentRegistry}. */
export const agentOnlinePresenceFromRegistry: AgentOnlinePresencePort = {
  async resolvePresenceForUser(agentId: string, userId: string): Promise<AgentPresenceForUser> {
    const row = agentRegistry.findByAgentId(agentId);
    if (!row) {
      return { kind: "offline" };
    }
    if (row.userId === userId) {
      return { kind: "online_same_user" };
    }
    return { kind: "online_other_user" };
  },
};
