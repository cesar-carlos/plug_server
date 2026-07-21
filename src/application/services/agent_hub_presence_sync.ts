import type { AgentHubPresenceRoute } from "../../domain/ports/agent_hub_presence.port";
import { getAgentHubPresencePort } from "../../infrastructure/redis/presence/agent_hub_presence_redis";
import { env } from "../../shared/config/env";

export const syncAgentHubPresenceOnRegister = async (input: {
  readonly agentId: string;
  readonly socketId: string;
  readonly connectedAtMs: number;
}): Promise<void> => {
  const hubInstanceId = env.hubInstanceId.trim();
  if (hubInstanceId === "") {
    return;
  }
  await getAgentHubPresencePort().upsert(input.agentId, {
    hubInstanceId,
    socketId: input.socketId,
    connectedAtMs: input.connectedAtMs,
  });
};

export const syncAgentHubPresenceOnDisconnect = async (input: {
  readonly agentId: string;
  readonly socketId: string;
}): Promise<void> => {
  await getAgentHubPresencePort().removeIfSocketMatches(input.agentId, input.socketId);
};

export const syncAgentHubPresenceOnTouch = async (agentId: string): Promise<void> => {
  await getAgentHubPresencePort().touch(agentId);
};

/**
 * Returns the remote hub route for `agentId` when distributed presence is enabled
 * and a record exists; otherwise `null`. Used by relay conversation start to
 * distinguish "unknown agent" from "agent on another hub" without sticky affinity.
 */
export const resolveAgentHubPresenceRoute = async (
  agentId: string,
): Promise<AgentHubPresenceRoute | null> => {
  const presence = getAgentHubPresencePort();
  if (!presence.isEnabled) {
    return null;
  }
  return presence.resolveRoute(agentId);
};
