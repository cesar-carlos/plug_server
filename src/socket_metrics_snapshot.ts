import { getRelayMetricsSnapshot } from "./presentation/socket/hub/relay/rpc_bridge";
import { getRelayRateLimitMetricsSnapshot } from "./presentation/socket/hub/rate_limits/consumer_relay_rate_limiter";
import { getAgentsCommandSocketRateLimitMetricsSnapshot } from "./presentation/socket/hub/rate_limits/agents_command_socket_rate_limiter";
import { getClientSocketEventPublishSocketRateLimitMetricsSnapshot } from "./presentation/socket/hub/rate_limits/client_socket_event_publish_socket_rate_limiter";
import { getSocketConsumerMetricsSnapshot } from "./shared/metrics/socket_consumer.metrics";
import { getSocketHubErrorMetricsSnapshot } from "./shared/metrics/socket_hub_error.metrics";
import { getSocketAgentMetricsSnapshot } from "./shared/metrics/socket_agent.metrics";
import { getAgentInboundSequencerMetricsSnapshot } from "./presentation/socket/hub/relay/agent_inbound_sequencer";
import { getAgentInboundIngressMetricsSnapshot } from "./presentation/socket/hub/relay/agent_inbound_ingress_guard";
import { getSocketRateLimitRedisMetricsSnapshot } from "./application/services/socket_rate_limit_redis_metrics.service";
import { SOCKET_NAMESPACES } from "./shared/constants/socket_events";
import { resolveCurrentSocketServer, socketServerStates } from "./socket_state";
import type { ConsumerPreparationMetrics } from "./presentation/socket/hub/scheduling/consumer_preparation_coordinator";

export const getSocketMetricsSnapshot = (): {
  readonly namespaces: {
    readonly agents: number;
    readonly consumers: number;
  };
  readonly relay: ReturnType<typeof getRelayMetricsSnapshot>;
  readonly relayRateLimit: ReturnType<typeof getRelayRateLimitMetricsSnapshot>;
  readonly socketRateLimitRedis: ReturnType<typeof getSocketRateLimitRedisMetricsSnapshot>;
  readonly agentsCommandSocketRateLimit: ReturnType<
    typeof getAgentsCommandSocketRateLimitMetricsSnapshot
  >;
  readonly clientSocketEventPublishSocketRateLimit: ReturnType<
    typeof getClientSocketEventPublishSocketRateLimitMetricsSnapshot
  >;
  readonly consumerRuntime: ReturnType<typeof getSocketConsumerMetricsSnapshot>;
  readonly consumerPreparation?: ConsumerPreparationMetrics;
  readonly agentRuntime: ReturnType<typeof getSocketAgentMetricsSnapshot>;
  readonly agentInboundSequencer: ReturnType<typeof getAgentInboundSequencerMetricsSnapshot>;
  readonly agentInboundIngress: ReturnType<typeof getAgentInboundIngressMetricsSnapshot>;
  readonly hubErrors: ReturnType<typeof getSocketHubErrorMetricsSnapshot>;
} => {
  const io = resolveCurrentSocketServer();
  const consumerPreparation = {
    active: 0,
    waiting: 0,
    waitingBytes: 0,
    waitCount: 0,
    waitSumMs: 0,
    waitMaxMs: 0,
  };
  for (const state of socketServerStates.values()) {
    const metrics = state.consumerPreparation.getMetrics();
    consumerPreparation.active += metrics.active;
    consumerPreparation.waiting += metrics.waiting;
    consumerPreparation.waitingBytes += metrics.waitingBytes;
    consumerPreparation.waitCount += metrics.waitCount;
    consumerPreparation.waitSumMs += metrics.waitSumMs;
    consumerPreparation.waitMaxMs = Math.max(consumerPreparation.waitMaxMs, metrics.waitMaxMs);
  }
  return {
    namespaces: {
      agents: io?.of(SOCKET_NAMESPACES.agents).sockets.size ?? 0,
      consumers: io?.of(SOCKET_NAMESPACES.consumers).sockets.size ?? 0,
    },
    relay: getRelayMetricsSnapshot(),
    relayRateLimit: getRelayRateLimitMetricsSnapshot(),
    socketRateLimitRedis: getSocketRateLimitRedisMetricsSnapshot(),
    agentsCommandSocketRateLimit: getAgentsCommandSocketRateLimitMetricsSnapshot(),
    clientSocketEventPublishSocketRateLimit:
      getClientSocketEventPublishSocketRateLimitMetricsSnapshot(),
    consumerRuntime: getSocketConsumerMetricsSnapshot(),
    consumerPreparation,
    agentRuntime: getSocketAgentMetricsSnapshot(),
    agentInboundSequencer: getAgentInboundSequencerMetricsSnapshot(),
    agentInboundIngress: getAgentInboundIngressMetricsSnapshot(),
    hubErrors: getSocketHubErrorMetricsSnapshot(),
  };
};
