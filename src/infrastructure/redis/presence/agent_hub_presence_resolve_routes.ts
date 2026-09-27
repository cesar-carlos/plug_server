import type {
  AgentHubPresenceRecord,
  AgentHubPresenceRoute,
} from "../../../domain/ports/agent_hub_presence.port";
import { agentHubPresenceKey } from "./agent_hub_presence_keys";

export const AGENT_HUB_PRESENCE_RESOLVE_ROUTES_CHUNK_SIZE = 1_000;

export const parseAgentHubPresenceRecord = (raw: string): AgentHubPresenceRecord | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.hubInstanceId !== "string" ||
      typeof record.socketId !== "string" ||
      typeof record.connectedAtMs !== "number" ||
      typeof record.lastSeenAtMs !== "number"
    ) {
      return null;
    }
    return {
      hubInstanceId: record.hubInstanceId,
      socketId: record.socketId,
      connectedAtMs: record.connectedAtMs,
      lastSeenAtMs: record.lastSeenAtMs,
    };
  } catch {
    return null;
  }
};

export const resolvePresenceRoutesWithMget = async (
  agentIds: readonly string[],
  mGet: (keys: readonly string[]) => Promise<readonly (string | null)[]>,
): Promise<ReadonlyMap<string, AgentHubPresenceRoute>> => {
  const resolved = new Map<string, AgentHubPresenceRoute>();
  const uniqueIds = [...new Set(agentIds)];
  if (uniqueIds.length === 0) {
    return resolved;
  }
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += AGENT_HUB_PRESENCE_RESOLVE_ROUTES_CHUNK_SIZE
  ) {
    const chunk = uniqueIds.slice(offset, offset + AGENT_HUB_PRESENCE_RESOLVE_ROUTES_CHUNK_SIZE);
    const keys = chunk.map((agentId) => agentHubPresenceKey(agentId));
    const rawValues = await mGet(keys);
    for (let index = 0; index < chunk.length; index += 1) {
      const raw = rawValues[index];
      if (typeof raw !== "string") {
        continue;
      }
      const record = parseAgentHubPresenceRecord(raw);
      if (record === null) {
        continue;
      }
      resolved.set(chunk[index]!, { hubInstanceId: record.hubInstanceId });
    }
  }
  return resolved;
};
