import { redisKeyNamespace } from "../keyspace/redis_key_namespace";
import { sanitizeRedisKeySegment } from "../keyspace/redis_key_namespace";

const presencePrefix = (): string => `plug_agent_presence:${redisKeyNamespace()}:agent:`;

export const agentHubPresenceKey = (agentId: string): string =>
  `${presencePrefix()}${sanitizeRedisKeySegment(agentId)}`;

export const agentHubBridgeCmdChannel = (hubInstanceId: string): string =>
  `plug_bridge_cmd:${redisKeyNamespace()}:${sanitizeRedisKeySegment(hubInstanceId)}`;

export const agentHubBridgeReplyChannel = (correlationId: string): string =>
  `plug_bridge_reply:${redisKeyNamespace()}:${sanitizeRedisKeySegment(correlationId)}`;
