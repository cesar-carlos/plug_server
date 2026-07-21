import type { AgentHubPresenceRoute } from "../../domain/ports/agent_hub_presence.port";
import { getAgentHubPresencePort } from "../../infrastructure/redis/presence/agent_hub_presence_redis";
import { env } from "../../shared/config/env";

/**
 * Local throttle for Redis presence TTL refreshes. Heartbeats update local
 * liveness every time; Redis only needs renew within a fraction of the TTL.
 * Keyed by agentId; cleared on register (fresh upsert) and disconnect.
 */
const lastRedisPresenceTouchMsByAgentId = new Map<string, number>();

/** Renew Redis presence at most once per this fraction of the TTL window. */
const PRESENCE_REDIS_TOUCH_MIN_INTERVAL_FRACTION = 1 / 3;

const presenceRedisTouchMinIntervalMs = (): number =>
  Math.max(1, Math.floor(env.agentHubPresenceTtlMs * PRESENCE_REDIS_TOUCH_MIN_INTERVAL_FRACTION));

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
  lastRedisPresenceTouchMsByAgentId.set(input.agentId, Date.now());
};

export const syncAgentHubPresenceOnDisconnect = async (input: {
  readonly agentId: string;
  readonly socketId: string;
}): Promise<void> => {
  lastRedisPresenceTouchMsByAgentId.delete(input.agentId);
  await getAgentHubPresencePort().removeIfSocketMatches(input.agentId, input.socketId);
};

/**
 * Refreshes Redis presence TTL for `agentId`, throttled so high-frequency
 * heartbeats do not pay a Redis RTT every tick. Local registry touch stays
 * unconditional at the call site.
 */
export const syncAgentHubPresenceOnTouch = async (agentId: string): Promise<void> => {
  const nowMs = Date.now();
  const lastTouchMs = lastRedisPresenceTouchMsByAgentId.get(agentId);
  if (lastTouchMs !== undefined && nowMs - lastTouchMs < presenceRedisTouchMinIntervalMs()) {
    return;
  }
  lastRedisPresenceTouchMsByAgentId.set(agentId, nowMs);
  await getAgentHubPresencePort().touch(agentId);
};

/** Test helper: clears local presence-touch throttle state. */
export const resetAgentHubPresenceTouchThrottleForTests = (): void => {
  lastRedisPresenceTouchMsByAgentId.clear();
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
