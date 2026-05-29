import type { Request, Response } from "express";

import { getBridgeLatencyTraceMetricsSnapshot } from "../../../application/services/bridge_latency_trace.service";
import { getBridgeRpcMethodMetricsSnapshot } from "../../../application/services/bridge_rpc_method_metrics.service";
import { getAgentDataMaintenanceMetricsSnapshot } from "../../../application/services/agent_data_maintenance.service";
import { getPrismaTransactionRetryMetricsSnapshot } from "../../../application/services/prisma_transaction_retry_metrics.service";
import { getRestBridgeMetricsSnapshot } from "../../../application/services/rest_bridge_metrics.service";
import { getRestHttpRateLimitMetricsSnapshot } from "../../../application/services/rest_http_rate_limit_metrics.service";
import { getAgentHubPresenceRedisMetricsSnapshot } from "../../../application/services/agent_hub_presence_redis_metrics.service";
import { getRestRateLimitRedisMetricsSnapshot } from "../../../application/services/rest_rate_limit_redis_metrics.service";
import { getSocketIoRedisAdapterMetricsSnapshot } from "../../../application/services/socket_io_redis_adapter_metrics.service";
import { getClientSocketEventIdempotencyRedisMetricsSnapshot } from "../../../application/services/client_socket_event_idempotency_redis_metrics.service";
import { getAgentEventStreamMetricsSnapshot } from "../../../application/services/agent_event_stream_metrics.service";
import { getRedisAuthPingMetricsSnapshot } from "../../../application/services/redis_auth_ping_metrics.service";
import { getAuthAccountMetricsSnapshot } from "../../../shared/metrics/auth_account.metrics";
import { getClientAgentAccessPublicDecisionMetricsSnapshot } from "../../../shared/metrics/client_agent_access_public_decision.metrics";
import { getClientAgentAccessRequestPostMetricsSnapshot } from "../../../shared/metrics/client_agent_access_request.metrics";
import { getClientMeAgentsMetricsSnapshot } from "../../../shared/metrics/client_me_agents.metrics";
import { getHttpRedMetricsSnapshot } from "../../../shared/metrics/http_red.metrics";
import { getPayloadFrameMetricsSnapshot } from "../../../shared/metrics/payload_frame.metrics";
import { getRegistrationFlowMetricsSnapshot } from "../../../shared/metrics/registration_flow.metrics";
import { getSocketAuditMetricsSnapshot } from "../../../application/services/socket_audit.service";
import type { SocketHubMetricsSnapshot } from "../../adapters/socket_metrics_snapshot.adapter";
import { container } from "../../../shared/di/container";
import { env } from "../../../shared/config/env";

import { buildMetricsLines } from "./metrics_renderer";

/**
 * Cache holds the **Buffer** rather than the source string so cache hits skip
 * the UTF-8 encoding pass that `response.send(string)` would do otherwise.
 */
let metricsResponseCache: {
  body: Buffer;
  expiresAtMs: number;
} | null = null;

export const getMetrics = (_request: Request, response: Response): void => {
  const nowMs = Date.now();
  const metricsResponseCacheTtlMs = env.metricsResponseCacheTtlMs;
  const cached = metricsResponseCache;
  if (metricsResponseCacheTtlMs > 0 && cached && cached.expiresAtMs > nowMs) {
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.status(200).send(cached.body);
    return;
  }

  const lines = buildMetricsLines({
    socket: container.socketMetricsSnapshotProvider.getSnapshot() as SocketHubMetricsSnapshot,
    restBridge: getRestBridgeMetricsSnapshot(),
    bridgeRpcMethods: getBridgeRpcMethodMetricsSnapshot(),
    audit: getSocketAuditMetricsSnapshot(),
    bridgeLatency: getBridgeLatencyTraceMetricsSnapshot(),
    agentDataMaintenance: getAgentDataMaintenanceMetricsSnapshot(),
    restHttpRl: getRestHttpRateLimitMetricsSnapshot(),
    restRateLimitRedis: getRestRateLimitRedisMetricsSnapshot(),
    agentHubPresenceRedis: getAgentHubPresenceRedisMetricsSnapshot(),
    socketIoRedisAdapter: getSocketIoRedisAdapterMetricsSnapshot(),
    customEventIdempotencyRedis: getClientSocketEventIdempotencyRedisMetricsSnapshot(),
    agentEventStream: getAgentEventStreamMetricsSnapshot(),
    redisAuthPing: getRedisAuthPingMetricsSnapshot(),
    prismaTransactionRetry: getPrismaTransactionRetryMetricsSnapshot(),
    registrationFlow: getRegistrationFlowMetricsSnapshot(),
    authAccount: getAuthAccountMetricsSnapshot(),
    clientMeAgents: getClientMeAgentsMetricsSnapshot(),
    clientAccessRequestPost: getClientAgentAccessRequestPostMetricsSnapshot(),
    clientAccessPublicDecision: getClientAgentAccessPublicDecisionMetricsSnapshot(),
    payloadFrame: getPayloadFrameMetricsSnapshot(),
    httpRed: getHttpRedMetricsSnapshot(),
  });

  const body = Buffer.from(`${lines.join("\n")}\n`);
  metricsResponseCache = {
    body,
    expiresAtMs: nowMs + metricsResponseCacheTtlMs,
  };
  response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(body);
};
