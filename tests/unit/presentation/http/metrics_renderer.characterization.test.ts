import { describe, expect, it } from "vitest";

import { getBridgeLatencyTraceMetricsSnapshot } from "../../../../src/application/services/bridge_latency_trace.service";
import { getBridgeRpcMethodMetricsSnapshot } from "../../../../src/application/services/bridge_rpc_method_metrics.service";
import { getAgentDataMaintenanceMetricsSnapshot } from "../../../../src/application/services/agent_data_maintenance.service";
import { getPrismaTransactionRetryMetricsSnapshot } from "../../../../src/application/services/prisma_transaction_retry_metrics.service";
import { getRestBridgeMetricsSnapshot } from "../../../../src/application/services/rest_bridge_metrics.service";
import { getRestHttpRateLimitMetricsSnapshot } from "../../../../src/application/services/rest_http_rate_limit_metrics.service";
import { getAgentHubPresenceRedisMetricsSnapshot } from "../../../../src/application/services/agent_hub_presence_redis_metrics.service";
import { getRestRateLimitRedisMetricsSnapshot } from "../../../../src/application/services/rest_rate_limit_redis_metrics.service";
import { getSocketIoRedisAdapterMetricsSnapshot } from "../../../../src/application/services/socket_io_redis_adapter_metrics.service";
import { getClientSocketEventIdempotencyRedisMetricsSnapshot } from "../../../../src/application/services/client_socket_event_idempotency_redis_metrics.service";
import { getAgentEventStreamMetricsSnapshot } from "../../../../src/application/services/agent_event_stream_metrics.service";
import { getRedisAuthPingMetricsSnapshot } from "../../../../src/application/services/redis_auth_ping_metrics.service";
import { getAuthAccountMetricsSnapshot } from "../../../../src/shared/metrics/auth_account.metrics";
import { getClientAgentAccessPublicDecisionMetricsSnapshot } from "../../../../src/shared/metrics/client_agent_access_public_decision.metrics";
import { getClientRegistrationPublicDecisionMetricsSnapshot } from "../../../../src/shared/metrics/client_registration_public_decision.metrics";
import { getClientAgentAccessRequestPostMetricsSnapshot } from "../../../../src/shared/metrics/client_agent_access_request.metrics";
import { getClientMeAgentsMetricsSnapshot } from "../../../../src/shared/metrics/client_me_agents.metrics";
import { getClientPasswordRecoveryMetricsSnapshot } from "../../../../src/shared/metrics/client_password_recovery.metrics";
import { getHttpRedMetricsSnapshot } from "../../../../src/shared/metrics/http_red.metrics";
import { getPayloadFrameMetricsSnapshot } from "../../../../src/shared/metrics/payload_frame.metrics";
import { getRegistrationFlowMetricsSnapshot } from "../../../../src/shared/metrics/registration_flow.metrics";
import { getSocketAuditMetricsSnapshot } from "../../../../src/application/services/socket_audit.service";
import type { SocketHubMetricsSnapshot } from "../../../../src/presentation/adapters/socket_metrics_snapshot.adapter";
import { container } from "../../../../src/shared/di/container";
import {
  buildMetricsLines,
  type MetricsSnapshots,
} from "../../../../src/presentation/http/controllers/metrics_renderer";

const buildSnapshots = (): MetricsSnapshots => ({
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
  clientPasswordRecovery: getClientPasswordRecoveryMetricsSnapshot(),
  clientAccessRequestPost: getClientAgentAccessRequestPostMetricsSnapshot(),
  clientAccessPublicDecision: getClientAgentAccessPublicDecisionMetricsSnapshot(),
  clientRegistrationPublicDecision: getClientRegistrationPublicDecisionMetricsSnapshot(),
  payloadFrame: getPayloadFrameMetricsSnapshot(),
  httpRed: getHttpRedMetricsSnapshot(),
});

/** Metric name = the token before the first `{` (labels) or whitespace (value). */
const metricNameOf = (line: string): string => {
  const trimmed = line.trim();
  const cut = trimmed.search(/[\s{]/);
  return cut === -1 ? trimmed : trimmed.slice(0, cut);
};

/**
 * Normalizes a metric line to `name{labels} <v>` by stripping the trailing
 * numeric value. Pins metric names, label sets, and emission order while
 * tolerating dynamic counter/gauge values, so a structural refactor (splitting
 * the renderer into per-subsystem functions) is fully protected.
 */
const normalizeStructure = (line: string): string =>
  line.replace(/\s-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i, " <v>");

/**
 * Characterization test for `buildMetricsLines`. It pins the *surface* of the
 * Prometheus exposition (the sorted set of metric names) so the renderer can be
 * refactored (e.g. split into per-subsystem renderers) without silently
 * dropping, renaming, or duplicating a metric. Values are intentionally not
 * asserted (they are dynamic); only the emitted metric-name set is locked.
 */
describe("buildMetricsLines characterization", () => {
  it("emits well-formed Prometheus lines", () => {
    const lines = buildMetricsLines(buildSnapshots());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Each non-comment line must be `name[{labels}] value`.
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})?\s-?[0-9].*$/);
    }
  });

  it("pins the emitted metric-name surface (refactor safety net)", () => {
    const lines = buildMetricsLines(buildSnapshots());
    const names = [...new Set(lines.map(metricNameOf))].sort();
    expect(names).toMatchSnapshot();
  });

  it("pins the full emission structure: names, labels and order (values normalized)", () => {
    const lines = buildMetricsLines(buildSnapshots());
    expect(lines.map(normalizeStructure)).toMatchSnapshot();
  });
});
