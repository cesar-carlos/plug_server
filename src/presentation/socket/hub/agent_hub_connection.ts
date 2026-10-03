import { getAgentHubPresencePort } from "../../../infrastructure/redis/presence/agent_hub_presence_redis";
import { agentRegistry } from "./registries/agent_registry";

/**
 * Whether the agent is connected to this hub cluster (local registry or Redis presence).
 */
export const isAgentConnectedToHub = async (agentId: string): Promise<boolean> => {
  if (agentRegistry.isRegistered(agentId)) {
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
  agentRegistry.isRegistered(agentId);

/**
 * Resolves hub connectivity for a set of agent ids (local + Redis presence).
 */
export const resolveClusterHubConnectedAgentIds = async (
  agentIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const connected = new Set<string>();
  const remoteIds: string[] = [];
  const presence = getAgentHubPresencePort();
  for (const agentId of agentIds) {
    if (agentRegistry.isRegistered(agentId)) {
      connected.add(agentId);
      continue;
    }
    if (presence.isEnabled) {
      remoteIds.push(agentId);
    }
  }
  if (remoteIds.length === 0) {
    return connected;
  }
  try {
    const routes = await presence.resolveRoutes(remoteIds);
    for (const agentId of remoteIds) {
      if (routes.get(agentId) !== undefined) {
        connected.add(agentId);
      }
    }
  } catch {
    for (const agentId of remoteIds) {
      const route = await presence.resolveRoute(agentId);
      if (route !== null) {
        connected.add(agentId);
      }
    }
  }
  return connected;
};

/** Fresh admission check: unlike response enrichment, Redis failures remain visible. */
export const resolveClusterHubConnectedAgentIdsStrict = async (
  agentIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const connected = new Set<string>();
  const remote: string[] = [];
  const presence = getAgentHubPresencePort();
  for (const id of new Set(agentIds)) {
    if (agentRegistry.isRegistered(id)) connected.add(id);
    else if (presence.isEnabled) remote.push(id);
  }
  if (remote.length === 0) return connected;
  if (presence.resolveRoutesStrict !== undefined) {
    const routes = await presence.resolveRoutesStrict(remote);
    for (const id of remote) if (routes.has(id)) connected.add(id);
  } else {
    // Older presence ports expose only GET; bound this narrow adapter's concurrency.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, remote.length) }, async () => {
        while (next < remote.length) {
          const id = remote[next++]!;
          if (await presence.resolveRoute(id)) connected.add(id);
        }
      }),
    );
  }
  return connected;
};
