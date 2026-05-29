import { getAgentHubPresencePort } from "../../../infrastructure/redis/presence/agent_hub_presence_redis";
import { agentRegistry } from "./registries/agent_registry";

/**
 * Whether the agent is connected to this hub cluster (local registry or Redis presence).
 */
export const isAgentConnectedToHub = async (agentId: string): Promise<boolean> => {
  if (agentRegistry.findByAgentId(agentId) !== null) {
    return true;
  }
  const presence = getAgentHubPresencePort();
  if (!presence.isEnabled) {
    return false;
  }
  const route = await presence.resolveRoute(agentId);
  return route !== null;
};

/** Sync check: local registry only. */
export const isAgentConnectedToHubLocally = (agentId: string): boolean =>
  agentRegistry.findByAgentId(agentId) !== null;

/**
 * Resolves hub connectivity for a set of agent ids (local + Redis presence).
 */
export const resolveClusterHubConnectedAgentIds = async (
  agentIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const connected = new Set<string>();
  const presence = getAgentHubPresencePort();
  for (const agentId of agentIds) {
    if (agentRegistry.findByAgentId(agentId) !== null) {
      connected.add(agentId);
      continue;
    }
    if (presence.isEnabled) {
      const route = await presence.resolveRoute(agentId);
      if (route !== null) {
        connected.add(agentId);
      }
    }
  }
  return connected;
};
