import type { getBridgeLatencyTraceMetricsSnapshot } from "../../../application/services/bridge_latency_trace.service";
import type { getBridgeRpcMethodMetricsSnapshot } from "../../../application/services/bridge_rpc_method_metrics.service";
import type { getAgentDataMaintenanceMetricsSnapshot } from "../../../application/services/agent_data_maintenance.service";
import type { getPrismaTransactionRetryMetricsSnapshot } from "../../../application/services/prisma_transaction_retry_metrics.service";
import type { getRestBridgeMetricsSnapshot } from "../../../application/services/rest_bridge_metrics.service";
import type { getRestHttpRateLimitMetricsSnapshot } from "../../../application/services/rest_http_rate_limit_metrics.service";
import type { getRestRateLimitRedisMetricsSnapshot } from "../../../application/services/rest_rate_limit_redis_metrics.service";
import type { getSocketIoRedisAdapterMetricsSnapshot } from "../../../application/services/socket_io_redis_adapter_metrics.service";
import type { getClientSocketEventIdempotencyRedisMetricsSnapshot } from "../../../application/services/client_socket_event_idempotency_redis_metrics.service";
import type { getAgentEventStreamMetricsSnapshot } from "../../../application/services/agent_event_stream_metrics.service";
import type { getRedisAuthPingMetricsSnapshot } from "../../../application/services/redis_auth_ping_metrics.service";
import { agentProfileReliabilityMetrics } from "../../../application/services/agent_profile_reliability_metrics.service";
import type { getAuthAccountMetricsSnapshot } from "../../../shared/metrics/auth_account.metrics";
import type { getClientAgentAccessPublicDecisionMetricsSnapshot } from "../../../shared/metrics/client_agent_access_public_decision.metrics";
import type { getClientAgentAccessRequestPostMetricsSnapshot } from "../../../shared/metrics/client_agent_access_request.metrics";
import type { getClientMeAgentsMetricsSnapshot } from "../../../shared/metrics/client_me_agents.metrics";
import type { HttpRedMetricsSnapshot } from "../../../shared/metrics/http_red.metrics";
import type { getPayloadFrameMetricsSnapshot } from "../../../shared/metrics/payload_frame.metrics";
import type { getRegistrationFlowMetricsSnapshot } from "../../../shared/metrics/registration_flow.metrics";
import type { getSocketAuditMetricsSnapshot } from "../../../application/services/socket_audit.service";
import { getClientSocketEventPublishIdempotencySerializationTrackedKeyCount } from "../../../application/services/client_socket_event_publish_idempotency_serialization";
import type { SocketHubMetricsSnapshot } from "../../adapters/socket_metrics_snapshot.adapter";

const escapePrometheusLabelValue = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const metricLine = (name: string, value: number, labels?: Record<string, string>): string => {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${value}`;
  }

  const renderedLabels = Object.entries(labels)
    .map(([key, item]) => `${key}="${escapePrometheusLabelValue(item)}"`)
    .join(",");

  return `${name}{${renderedLabels}} ${value}`;
};

/**
 * Append Prometheus histogram lines (`_bucket`, `_sum`, `_count`) plus the
 * pre-computed p50/p95/p99 gauges for a Redis command latency histogram
 * snapshot. The `+Inf` bucket equals the total `count` so observations
 * above the largest bucket are still represented.
 */
const appendRedisLatencyHistogram = (
  lines: string[],
  name: string,
  snapshot: {
    readonly buckets: readonly { readonly le: string; readonly count: number }[];
    readonly count: number;
    readonly sumMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  },
  labels?: Record<string, string>,
): void => {
  for (const bucket of snapshot.buckets) {
    lines.push(metricLine(`${name}_bucket`, bucket.count, { ...(labels ?? {}), le: bucket.le }));
  }
  lines.push(metricLine(`${name}_bucket`, snapshot.count, { ...(labels ?? {}), le: "+Inf" }));
  lines.push(metricLine(`${name}_sum`, snapshot.sumMs, labels));
  lines.push(metricLine(`${name}_count`, snapshot.count, labels));
  lines.push(metricLine(`${name}_p50`, snapshot.p50Ms, labels));
  lines.push(metricLine(`${name}_p95`, snapshot.p95Ms, labels));
  lines.push(metricLine(`${name}_p99`, snapshot.p99Ms, labels));
};

export interface MetricsSnapshots {
  readonly socket: SocketHubMetricsSnapshot;
  readonly restBridge: ReturnType<typeof getRestBridgeMetricsSnapshot>;
  readonly bridgeRpcMethods: ReturnType<typeof getBridgeRpcMethodMetricsSnapshot>;
  readonly audit: ReturnType<typeof getSocketAuditMetricsSnapshot>;
  readonly bridgeLatency: ReturnType<typeof getBridgeLatencyTraceMetricsSnapshot>;
  readonly agentDataMaintenance: ReturnType<typeof getAgentDataMaintenanceMetricsSnapshot>;
  readonly restHttpRl: ReturnType<typeof getRestHttpRateLimitMetricsSnapshot>;
  readonly restRateLimitRedis: ReturnType<typeof getRestRateLimitRedisMetricsSnapshot>;
  readonly socketIoRedisAdapter: ReturnType<typeof getSocketIoRedisAdapterMetricsSnapshot>;
  readonly customEventIdempotencyRedis: ReturnType<
    typeof getClientSocketEventIdempotencyRedisMetricsSnapshot
  >;
  readonly agentEventStream: ReturnType<typeof getAgentEventStreamMetricsSnapshot>;
  readonly redisAuthPing: ReturnType<typeof getRedisAuthPingMetricsSnapshot>;
  readonly prismaTransactionRetry: ReturnType<typeof getPrismaTransactionRetryMetricsSnapshot>;
  readonly registrationFlow: ReturnType<typeof getRegistrationFlowMetricsSnapshot>;
  readonly authAccount: ReturnType<typeof getAuthAccountMetricsSnapshot>;
  readonly clientMeAgents: ReturnType<typeof getClientMeAgentsMetricsSnapshot>;
  readonly clientAccessRequestPost: ReturnType<
    typeof getClientAgentAccessRequestPostMetricsSnapshot
  >;
  readonly clientAccessPublicDecision: ReturnType<
    typeof getClientAgentAccessPublicDecisionMetricsSnapshot
  >;
  readonly payloadFrame: ReturnType<typeof getPayloadFrameMetricsSnapshot>;
  readonly httpRed: HttpRedMetricsSnapshot;
}

export const buildMetricsLines = (snapshots: MetricsSnapshots): string[] => {
  const {
    socket,
    restBridge,
    bridgeRpcMethods,
    audit,
    bridgeLatency,
    agentDataMaintenance,
    restHttpRl,
    restRateLimitRedis,
    socketIoRedisAdapter,
    customEventIdempotencyRedis,
    agentEventStream,
    redisAuthPing,
    prismaTransactionRetry,
    registrationFlow,
    authAccount,
    clientMeAgents,
    clientAccessRequestPost,
    clientAccessPublicDecision,
    payloadFrame,
    httpRed,
  } = snapshots;
  const relay = socket.relay;
  const rateLimit = socket.relayRateLimit;
  const socketRateLimitRedis = socket.socketRateLimitRedis;
  const agentsCommandRl = socket.agentsCommandSocketRateLimit;
  const clientSocketEventPublishRl = socket.clientSocketEventPublishSocketRateLimit;
  const consumerRuntime = socket.consumerRuntime;
  const agentRuntime = socket.agentRuntime;
  const hubErrors = socket.hubErrors;

  const lines: string[] = [];

  lines.push(metricLine("plug_rest_bridge_requests_total", restBridge.requestsTotal));
  lines.push(
    metricLine("plug_rest_bridge_requests_success_total", restBridge.requestsSuccessTotal),
  );
  lines.push(metricLine("plug_rest_bridge_requests_failed_total", restBridge.requestsFailedTotal));
  lines.push(metricLine("plug_rest_bridge_latency_count", restBridge.latencyCount));
  lines.push(metricLine("plug_rest_bridge_latency_avg_ms", restBridge.latencyAvgMs));
  lines.push(metricLine("plug_rest_bridge_latency_max_ms", restBridge.latencyMaxMs));
  lines.push(metricLine("plug_rest_bridge_latency_p95_ms", restBridge.latencyP95Ms));
  lines.push(metricLine("plug_rest_bridge_latency_p99_ms", restBridge.latencyP99Ms));
  for (const item of bridgeRpcMethods) {
    const labels = {
      channel: item.channel,
      method: item.method,
      outcome: item.outcome,
    };
    lines.push(metricLine("plug_bridge_rpc_method_requests_total", item.count, labels));
    lines.push(metricLine("plug_bridge_rpc_method_latency_avg_ms", item.latencyAvgMs, labels));
    lines.push(metricLine("plug_bridge_rpc_method_latency_max_ms", item.latencyMaxMs, labels));
    lines.push(metricLine("plug_bridge_rpc_method_latency_p95_ms", item.latencyP95Ms, labels));
    lines.push(metricLine("plug_bridge_rpc_method_latency_p99_ms", item.latencyP99Ms, labels));
    for (const bucket of item.latencyBuckets) {
      lines.push(
        metricLine("plug_bridge_rpc_method_latency_bucket", bucket.count, {
          ...labels,
          le: bucket.le,
        }),
      );
    }
    lines.push(metricLine("plug_bridge_rpc_method_latency_sum", item.latencySumMs, labels));
    lines.push(metricLine("plug_bridge_rpc_method_latency_count", item.count, labels));
  }

  lines.push(
    metricLine("plug_rest_http_rate_limit_global_rejected_total", restHttpRl.globalRejectedTotal),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_credential_auth_rejected_total",
      restHttpRl.credentialAuthRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_token_refresh_rejected_total",
      restHttpRl.tokenRefreshRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_agents_commands_user_rejected_total",
      restHttpRl.agentsCommandsUserRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_agents_commands_ip_rejected_total",
      restHttpRl.agentsCommandsIpRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_agents_self_profile_rejected_total",
      restHttpRl.agentsSelfProfileRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_admin_user_status_rejected_total",
      restHttpRl.adminUserStatusRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_client_me_agents_post_rejected_total",
      restHttpRl.clientMeAgentsPostRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_client_thumbnail_rejected_total",
      restHttpRl.clientThumbnailRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_client_password_recovery_request_rejected_total",
      restHttpRl.clientPasswordRecoveryRequestRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_client_socket_event_publish_rejected_total",
      restHttpRl.clientSocketEventPublishRejectedTotal,
    ),
  );

  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_url_configured",
      restRateLimitRedis.redisUrlConfigured,
    ),
  );
  lines.push(
    metricLine("plug_rest_http_rate_limit_redis_store_active", restRateLimitRedis.redisStoreActive),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_fallback_events_total",
      restRateLimitRedis.fallbackEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_runtime_command_errors_total",
      restRateLimitRedis.runtimeCommandErrorEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_connection_events_total",
      restRateLimitRedis.connectionEventsTotal,
    ),
  );
  lines.push(
    metricLine("plug_rest_http_rate_limit_redis_circuit_open", restRateLimitRedis.circuitOpen),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_circuit_opened_total",
      restRateLimitRedis.circuitOpenedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_last_fallback_timestamp_ms",
      restRateLimitRedis.lastFallbackAtMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_http_rate_limit_redis_last_connection_timestamp_ms",
      restRateLimitRedis.lastConnectionAtMs,
    ),
  );
  appendRedisLatencyHistogram(
    lines,
    "plug_rest_http_rate_limit_redis_command_duration_ms",
    restRateLimitRedis.latency,
  );

  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_url_configured",
      socketRateLimitRedis.redisUrlConfigured,
    ),
  );
  lines.push(
    metricLine("plug_socket_rate_limit_redis_store_active", socketRateLimitRedis.redisStoreActive),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_fallback_events_total",
      socketRateLimitRedis.fallbackEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_runtime_command_errors_total",
      socketRateLimitRedis.runtimeCommandErrorEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_connection_events_total",
      socketRateLimitRedis.connectionEventsTotal,
    ),
  );
  lines.push(
    metricLine("plug_socket_rate_limit_redis_circuit_open", socketRateLimitRedis.circuitOpen),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_circuit_opened_total",
      socketRateLimitRedis.circuitOpenedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_allowed_total",
      socketRateLimitRedis.redisAllowedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_rejected_total",
      socketRateLimitRedis.redisRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_window_resets_total",
      socketRateLimitRedis.windowResetsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_window_saturations_total",
      socketRateLimitRedis.saturationsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_consume_atomic_rollbacks_total",
      socketRateLimitRedis.atomicRollbacksTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_tracked_keys_window_size",
      socketRateLimitRedis.trackedKeysWindowSize,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_tracked_keys_seen_total",
      socketRateLimitRedis.trackedKeysSeenTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_last_fallback_timestamp_ms",
      socketRateLimitRedis.lastFallbackAtMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_last_connection_timestamp_ms",
      socketRateLimitRedis.lastConnectionAtMs,
    ),
  );
  for (const op of ["consume", "refund"] as const) {
    appendRedisLatencyHistogram(
      lines,
      "plug_socket_rate_limit_redis_command_duration_ms",
      socketRateLimitRedis.latency[op],
      { op },
    );
  }
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_url_configured",
      socketIoRedisAdapter.redisUrlConfigured,
    ),
  );
  lines.push(
    metricLine("plug_socket_io_redis_adapter_active", socketIoRedisAdapter.redisAdapterActive),
  );
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_connection_events_total",
      socketIoRedisAdapter.connectionEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_fallback_events_total",
      socketIoRedisAdapter.fallbackEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_runtime_errors_total",
      socketIoRedisAdapter.runtimeErrorEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_last_connection_timestamp_ms",
      socketIoRedisAdapter.lastConnectionAtMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_last_fallback_timestamp_ms",
      socketIoRedisAdapter.lastFallbackAtMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_io_redis_adapter_attached_servers_total",
      socketIoRedisAdapter.attachedServersTotal,
    ),
  );
  appendRedisLatencyHistogram(
    lines,
    "plug_socket_io_redis_adapter_connect_duration_ms",
    socketIoRedisAdapter.connectLatency,
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_url_configured",
      customEventIdempotencyRedis.redisUrlConfigured,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_store_active",
      customEventIdempotencyRedis.redisStoreActive,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_connection_events_total",
      customEventIdempotencyRedis.connectionEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_fallback_events_total",
      customEventIdempotencyRedis.fallbackEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_command_errors_total",
      customEventIdempotencyRedis.runtimeCommandErrorEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_replay_hits_total",
      customEventIdempotencyRedis.replayHitsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_conflicts_total",
      customEventIdempotencyRedis.conflictsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_locks_acquired_total",
      customEventIdempotencyRedis.locksAcquiredTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_lock_contention_total",
      customEventIdempotencyRedis.lockContentionTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_lock_wait_timeouts_total",
      customEventIdempotencyRedis.lockWaitTimeoutsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_writes_total",
      customEventIdempotencyRedis.writesTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_idempotency_redis_lock_extensions_total",
      customEventIdempotencyRedis.lockExtensionsTotal,
    ),
  );
  for (const op of ["get", "set", "lock", "unlock", "extend"] as const) {
    appendRedisLatencyHistogram(
      lines,
      "plug_socket_custom_event_idempotency_redis_command_duration_ms",
      customEventIdempotencyRedis.latency[op],
      { op },
    );
  }
  lines.push(
    metricLine("plug_agent_event_stream_url_configured", agentEventStream.redisUrlConfigured),
  );
  lines.push(metricLine("plug_agent_event_stream_active", agentEventStream.redisStoreActive));
  lines.push(
    metricLine(
      "plug_agent_event_stream_connection_events_total",
      agentEventStream.connectionEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_event_stream_fallback_events_total",
      agentEventStream.fallbackEventsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_event_stream_runtime_command_errors_total",
      agentEventStream.runtimeCommandErrorEventsTotal,
    ),
  );
  lines.push(metricLine("plug_agent_event_stream_appends_total", agentEventStream.appendsTotal));
  lines.push(
    metricLine("plug_agent_event_stream_backlog_reads_total", agentEventStream.backlogReadsTotal),
  );
  lines.push(
    metricLine(
      "plug_agent_event_stream_backlog_entries_delivered_total",
      agentEventStream.backlogEntriesDeliveredTotal,
    ),
  );
  lines.push(metricLine("plug_agent_event_stream_acks_total", agentEventStream.acksTotal));
  lines.push(metricLine("plug_agent_event_stream_dropped_total", agentEventStream.droppedTotal));
  lines.push(
    metricLine("plug_agent_event_stream_batch_appends_total", agentEventStream.batchAppendsTotal),
  );
  lines.push(
    metricLine(
      "plug_agent_event_stream_batch_partial_failures_total",
      agentEventStream.batchPartialFailuresTotal,
    ),
  );
  for (const bucket of agentEventStream.batchSize.buckets) {
    lines.push(
      metricLine("plug_agent_event_stream_batch_size_bucket", bucket.count, { le: bucket.le }),
    );
  }
  lines.push(
    metricLine("plug_agent_event_stream_batch_size_bucket", agentEventStream.batchSize.count, {
      le: "+Inf",
    }),
  );
  lines.push(metricLine("plug_agent_event_stream_batch_size_sum", agentEventStream.batchSize.sum));
  lines.push(
    metricLine("plug_agent_event_stream_batch_size_count", agentEventStream.batchSize.count),
  );
  lines.push(
    metricLine(
      "plug_agent_event_stream_last_connection_timestamp_ms",
      agentEventStream.lastConnectionAtMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_event_stream_last_fallback_timestamp_ms",
      agentEventStream.lastFallbackAtMs,
    ),
  );
  for (const op of ["append", "read", "ack", "trim"] as const) {
    appendRedisLatencyHistogram(
      lines,
      "plug_agent_event_stream_command_duration_ms",
      agentEventStream.latency[op],
      { op },
    );
  }
  for (const entry of redisAuthPing) {
    lines.push(
      metricLine("plug_redis_auth_ping_total", entry.count, {
        module: entry.module,
        outcome: entry.outcome,
      }),
    );
  }
  lines.push(
    metricLine(
      "plug_prisma_transaction_retry_attempts_total",
      prismaTransactionRetry.retryAttemptsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_prisma_transaction_retries_exhausted_total",
      prismaTransactionRetry.retriesExhaustedTotal,
    ),
  );
  for (const [operation, value] of prismaTransactionRetry.retryAttemptsByOperation.entries()) {
    lines.push(
      metricLine("plug_prisma_transaction_retry_attempts_total", value, {
        operation,
      }),
    );
  }
  for (const [operation, value] of prismaTransactionRetry.retriesExhaustedByOperation.entries()) {
    lines.push(
      metricLine("plug_prisma_transaction_retries_exhausted_total", value, {
        operation,
      }),
    );
  }

  lines.push(
    metricLine("plug_registration_approved_total", registrationFlow.registrationApprovedTotal),
  );
  lines.push(
    metricLine("plug_registration_rejected_total", registrationFlow.registrationRejectedTotal),
  );
  lines.push(
    metricLine(
      "plug_registration_token_expired_total",
      registrationFlow.registrationTokenExpiredTotal,
    ),
  );

  lines.push(metricLine("plug_auth_login_blocked_total", authAccount.loginBlockedTotal));
  lines.push(metricLine("plug_auth_refresh_blocked_total", authAccount.refreshBlockedTotal));
  lines.push(metricLine("plug_auth_socket_blocked_total", authAccount.socketBlockedTotal));
  lines.push(metricLine("plug_admin_user_status_set_total", authAccount.adminUserStatusSetTotal));

  lines.push(
    metricLine(
      "plug_agent_profile_writes_committed_total",
      agentProfileReliabilityMetrics.profileWritesCommittedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_idempotent_total",
      agentProfileReliabilityMetrics.profileWritesIdempotentTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_conflict_total",
      agentProfileReliabilityMetrics.profileWritesConflictTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_pull_sync_version_content_conflict_total",
      agentProfileReliabilityMetrics.profileWritesPullSyncVersionContentConflictTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_skipped_stale_remote_version_total",
      agentProfileReliabilityMetrics.profileWritesSkippedStaleRemoteVersionTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_skipped_missing_timestamp_total",
      agentProfileReliabilityMetrics.profileWritesSkippedMissingTimestampTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_skipped_stale_timestamp_total",
      agentProfileReliabilityMetrics.profileWritesSkippedStaleTimestampTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_writes_legacy_no_expected_version_total",
      agentProfileReliabilityMetrics.profileWritesLegacyNoExpectedVersionTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_sync_register_snapshot_total",
      agentProfileReliabilityMetrics.profileSyncRegisterSnapshotTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_sync_fallback_rpc_total",
      agentProfileReliabilityMetrics.profileSyncFallbackRpcTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_sync_deduped_in_flight_total",
      agentProfileReliabilityMetrics.profileSyncDedupedInFlightTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_sync_skipped_recent_duplicate_total",
      agentProfileReliabilityMetrics.profileSyncSkippedRecentDuplicateTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_sync_skipped_stale_session_total",
      agentProfileReliabilityMetrics.profileSyncSkippedStaleSessionTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_sync_failed_log_suppressed_total",
      agentProfileReliabilityMetrics.profileSyncFailedLogSuppressedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_broadcast_emitted_total",
      agentProfileReliabilityMetrics.profileBroadcastEmittedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_broadcast_failed_total",
      agentProfileReliabilityMetrics.profileBroadcastFailedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_maintenance_prune_runs_total",
      agentDataMaintenance.profilePruneRuns,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_maintenance_revisions_deleted_total",
      agentDataMaintenance.profileRevisionsDeleted,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_maintenance_idempotency_deleted_total",
      agentDataMaintenance.profileIdempotencyDeleted,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_profile_maintenance_prune_failed_total",
      agentDataMaintenance.profilePruneFailed,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_expiry_runs_total",
      agentDataMaintenance.clientAccessExpiryRuns,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_requests_expired_total",
      agentDataMaintenance.clientAccessRequestsExpired,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_expired_tokens_deleted_total",
      agentDataMaintenance.clientAccessTokensDeleted,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_expiry_failed_total",
      agentDataMaintenance.clientAccessExpiryFailed,
    ),
  );
  lines.push(
    metricLine("plug_client_me_agents_list_responses_total", clientMeAgents.listResponsesTotal),
  );
  lines.push(
    metricLine(
      "plug_client_me_agents_list_hub_connected_true_total",
      clientMeAgents.listHubConnectedTrueTotal,
    ),
  );
  lines.push(
    metricLine("plug_client_me_agents_detail_responses_total", clientMeAgents.detailResponsesTotal),
  );
  lines.push(
    metricLine(
      "plug_client_me_agents_detail_hub_connected_true_total",
      clientMeAgents.detailHubConnectedTrueTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_request_post_requested_total",
      clientAccessRequestPost.postRequestedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_request_post_new_total",
      clientAccessRequestPost.postNewRequestsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_request_post_reopened_total",
      clientAccessRequestPost.postReopenedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_request_post_debounced_total",
      clientAccessRequestPost.postDebouncedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_client_agent_access_request_post_already_approved_total",
      clientAccessRequestPost.postAlreadyApprovedTotal,
    ),
  );
  for (const decision of ["approve", "reject"] as const) {
    const decisionMetrics = clientAccessPublicDecision[decision];
    lines.push(
      metricLine(
        "plug_client_agent_access_public_decision_started_total",
        decisionMetrics.startedTotal,
        { decision },
      ),
    );
    lines.push(
      metricLine(
        "plug_client_agent_access_public_decision_latency_count",
        decisionMetrics.latencyCount,
        { decision },
      ),
    );
    lines.push(
      metricLine(
        "plug_client_agent_access_public_decision_latency_sum_ms",
        decisionMetrics.latencySumMs,
        { decision },
      ),
    );
    lines.push(
      metricLine(
        "plug_client_agent_access_public_decision_latency_max_ms",
        decisionMetrics.latencyMaxMs,
        { decision },
      ),
    );
    lines.push(
      metricLine(
        "plug_client_agent_access_public_decision_latency_avg_ms",
        decisionMetrics.latencyAvgMs,
        { decision },
      ),
    );
    for (const [outcome, value] of Object.entries(decisionMetrics.outcomes)) {
      lines.push(
        metricLine("plug_client_agent_access_public_decision_outcomes_total", value, {
          decision,
          outcome,
        }),
      );
    }
  }
  lines.push(
    metricLine(
      "plug_agent_data_maintenance_pending_operations",
      agentDataMaintenance.pendingOperations,
    ),
  );

  lines.push(
    metricLine("plug_socket_namespace_connections", socket.namespaces.agents, {
      namespace: "agents",
    }),
  );
  lines.push(
    metricLine("plug_socket_namespace_connections", socket.namespaces.consumers, {
      namespace: "consumers",
    }),
  );
  lines.push(
    metricLine("plug_socket_consumers_active_connections", consumerRuntime.activeConnections.user, {
      principal_type: "user",
    }),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_active_connections",
      consumerRuntime.activeConnections.client,
      { principal_type: "client" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_active_connections",
      consumerRuntime.activeConnections.unknown,
      { principal_type: "unknown" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_auth_rejected_total",
      consumerRuntime.authRejects.missing_token,
      { reason: "missing_token" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_auth_rejected_total",
      consumerRuntime.authRejects.invalid_token,
      { reason: "invalid_token" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_auth_rejected_total",
      consumerRuntime.authRejects.role_denied,
      { reason: "role_denied" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_auth_rejected_total",
      consumerRuntime.authRejects.blocked_account,
      { reason: "blocked_account" },
    ),
  );
  lines.push(
    metricLine("plug_socket_agents_auth_rejected_total", agentRuntime.authRejects.missing_token, {
      reason: "missing_token",
    }),
  );
  lines.push(
    metricLine("plug_socket_agents_auth_rejected_total", agentRuntime.authRejects.invalid_token, {
      reason: "invalid_token",
    }),
  );
  lines.push(
    metricLine("plug_socket_agents_auth_rejected_total", agentRuntime.authRejects.role_denied, {
      reason: "role_denied",
    }),
  );
  lines.push(
    metricLine("plug_socket_agents_auth_rejected_total", agentRuntime.authRejects.blocked_account, {
      reason: "blocked_account",
    }),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_auth_rejected_total",
      agentRuntime.authRejects.account_validation_error,
      { reason: "account_validation_error" },
    ),
  );
  lines.push(
    metricLine("plug_agent_session_rejected_active_total", agentRuntime.sessionRejectedActiveTotal),
  );
  lines.push(
    metricLine(
      "plug_agent_session_takeover_disconnect_total",
      agentRuntime.sessionTakeoverDisconnectTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_idle_timeout_disconnect_total",
      agentRuntime.agentIdleTimeoutDisconnectTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_agent_session_register_rate_limited_total",
      agentRuntime.sessionRegisterRateLimitedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_ready_legacy_payload_total",
      agentRuntime.agentReadyLegacyPayloadTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_ready_invalid_partial_payload_total",
      agentRuntime.agentReadyInvalidPartialPayloadTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_inbound_contract_validation_failed_total",
      agentRuntime.inboundContractValidation.failedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_inbound_contract_validation_warn_total",
      agentRuntime.inboundContractValidation.warnTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_capability_profiles_total",
      agentRuntime.capabilityProfiles.current,
      { status: "current" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_capability_profiles_total",
      agentRuntime.capabilityProfiles.older,
      { status: "older" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_capability_profiles_total",
      agentRuntime.capabilityProfiles.unknown,
      { status: "unknown" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_capability_agent_get_health_capable_total",
      agentRuntime.capabilityAgentGetHealthCapableTotal,
    ),
  );
  for (const [keyKind, value] of Object.entries(payloadFrame.signatureAccepted)) {
    lines.push(
      metricLine("plug_payload_frame_signature_accepted_total", value, { key_kind: keyKind }),
    );
  }
  for (const [reason, value] of Object.entries(payloadFrame.signatureRejected)) {
    lines.push(metricLine("plug_payload_frame_signature_rejected_total", value, { reason }));
  }
  lines.push(
    metricLine(
      "plug_socket_agents_health_responses_total",
      agentRuntime.agentHealth.responsesTotal,
    ),
  );
  lines.push(
    metricLine("plug_socket_agents_health_errors_total", agentRuntime.agentHealth.errorsTotal),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_seen_timestamp_ms",
      agentRuntime.agentHealth.lastSeenAtMs,
    ),
  );
  lines.push(
    metricLine("plug_socket_agents_health_last_healthy", agentRuntime.agentHealth.lastHealthy),
  );
  lines.push(
    metricLine("plug_socket_agents_health_last_degraded", agentRuntime.agentHealth.lastDegraded),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_uptime_seconds",
      agentRuntime.agentHealth.lastUptimeSeconds,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_sql_queue_current_size",
      agentRuntime.agentHealth.lastSqlQueueCurrentSize,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_sql_queue_max_size",
      agentRuntime.agentHealth.lastSqlQueueMaxSize,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_active_workers",
      agentRuntime.agentHealth.lastActiveWorkers,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_max_workers",
      agentRuntime.agentHealth.lastMaxWorkers,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_sql_queue_rejections",
      agentRuntime.agentHealth.lastSqlQueueRejectionsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_sql_queue_timeouts",
      agentRuntime.agentHealth.lastSqlQueueTimeoutsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_sql_queue_avg_wait_time_ms",
      agentRuntime.agentHealth.lastSqlQueueAvgWaitTimeMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_query_count",
      agentRuntime.agentHealth.lastQueryTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_query_errors",
      agentRuntime.agentHealth.lastQueryErrors,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_query_success_rate",
      agentRuntime.agentHealth.lastQuerySuccessRate,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_avg_latency_ms",
      agentRuntime.agentHealth.lastAvgLatencyMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_p95_latency_ms",
      agentRuntime.agentHealth.lastP95LatencyMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_health_last_p99_latency_ms",
      agentRuntime.agentHealth.lastP99LatencyMs,
    ),
  );
  lines.push(metricLine("plug_socket_consumers_guard_db_count", consumerRuntime.guardDb.count));
  lines.push(metricLine("plug_socket_consumers_guard_db_avg_ms", consumerRuntime.guardDb.avgMs));
  lines.push(metricLine("plug_socket_consumers_guard_db_max_ms", consumerRuntime.guardDb.maxMs));
  lines.push(
    metricLine(
      "plug_socket_consumers_commands_aborted_on_disconnect_total",
      consumerRuntime.commandAbort.abortedCommandsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_retry_after_ms_propagated_total",
      consumerRuntime.retryAfter.socketErrorRetryAfterMsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_command_retry_after_seconds_propagated_total",
      consumerRuntime.retryAfter.agentsCommandRetryAfterSecondsTotal,
    ),
  );
  // Relay opt-ins adoption / efficacy (Socket performance v2). See
  // `docs/socket_relay_protocol.md` for the operational interpretation.
  lines.push(
    metricLine(
      "plug_socket_relay_fast_path_requested_total",
      consumerRuntime.relayOptIns.fastPathRequestedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_fast_path_honored_total",
      consumerRuntime.relayOptIns.fastPathHonoredTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_fast_path_fallback_dedup_total",
      consumerRuntime.relayOptIns.fastPathFallbackDedupTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_fast_path_fallback_error_total",
      consumerRuntime.relayOptIns.fastPathFallbackErrorTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_fast_path_stream_inadvertent_total",
      consumerRuntime.relayOptIns.fastPathStreamInadvertentTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_fast_path_forbidden_total",
      consumerRuntime.relayOptIns.fastPathForbiddenTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_body_id_echo_total",
      consumerRuntime.relayOptIns.bodyIdEchoTotal,
    ),
  );
  // Overhead histogram-ish (sum + max + derived avg). Synthetic error builders
  // do not measure overhead, so this only tracks the response-forwarder path
  // where we sacrificed `canBypassReencode`. avg → ops-facing latency cost of
  // staying on Option B (vs the future Option A negotiated `clientRequestIdEcho`).
  lines.push(
    metricLine(
      "plug_socket_relay_body_id_echo_overhead_sum_ms",
      consumerRuntime.relayOptIns.bodyIdEchoOverheadSumMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_body_id_echo_overhead_max_ms",
      consumerRuntime.relayOptIns.bodyIdEchoOverheadMaxMs,
    ),
  );
  {
    const echoCount = consumerRuntime.relayOptIns.bodyIdEchoTotal;
    const echoAvg =
      echoCount > 0 ? consumerRuntime.relayOptIns.bodyIdEchoOverheadSumMs / echoCount : 0;
    lines.push(metricLine("plug_socket_relay_body_id_echo_overhead_avg_ms", echoAvg));
  }
  lines.push(
    metricLine(
      "plug_socket_relay_server_timings_opt_in_total",
      consumerRuntime.relayOptIns.serverTimingsRelayOptInTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_command_server_timings_opt_in_total",
      consumerRuntime.relayOptIns.serverTimingsAgentsCommandOptInTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_agents_command_server_timings_opt_in_total",
      consumerRuntime.relayOptIns.serverTimingsRestOptInTotal,
    ),
  );
  // Relay batch protocol (`relay:rpc.request.batch`) — see
  // `docs/adrs/0008-relay-batch-protocol.md`.
  lines.push(
    metricLine(
      "plug_socket_relay_batch_envelopes_received_total",
      consumerRuntime.relayOptIns.batchEnvelopesReceivedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_batch_envelopes_accepted_total",
      consumerRuntime.relayOptIns.batchEnvelopesAcceptedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_batch_items_accepted_total",
      consumerRuntime.relayOptIns.batchItemsAcceptedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_batch_items_deduped_total",
      consumerRuntime.relayOptIns.batchItemsDedupedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_batch_items_error_total",
      consumerRuntime.relayOptIns.batchItemsErrorTotal,
    ),
  );
  for (const [reason, count] of Object.entries(
    consumerRuntime.relayOptIns.batchEnvelopesRejectedTotal,
  )) {
    lines.push(
      metricLine("plug_socket_relay_batch_envelopes_rejected_total", count, { reason }),
    );
  }
  lines.push(
    metricLine(
      "plug_socket_custom_event_subscriptions_active",
      consumerRuntime.customEvents.subscriptionsActive,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_subscribed_total",
      consumerRuntime.customEvents.subscribedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_unsubscribed_total",
      consumerRuntime.customEvents.unsubscribedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_subscription_rejected_total",
      consumerRuntime.customEvents.subscriptionRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_subscription_forbidden_total",
      consumerRuntime.customEvents.subscriptionForbiddenTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_accepted_total",
      consumerRuntime.customEvents.publishAcceptedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_rejected_total",
      consumerRuntime.customEvents.publishRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_idempotent_replay_total",
      consumerRuntime.customEvents.publishIdempotentReplayTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_recipients_total",
      consumerRuntime.customEvents.publishRecipientsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_attachment_bytes_total",
      consumerRuntime.customEvents.publishAttachmentBytesTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_via_socket_total",
      consumerRuntime.customEvents.publishViaSocketTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_idempotency_serialization_cap_rejected_total",
      consumerRuntime.customEvents.publishIdempotencySerializationCapRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_distributed_recipient_count_failed_total",
      consumerRuntime.customEvents.publishDistributedRecipientCountFailedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_distributed_recipient_count_skipped_total",
      consumerRuntime.customEvents.publishDistributedRecipientCountSkippedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_distributed_recipient_count_circuit_opened_total",
      consumerRuntime.customEvents.publishDistributedRecipientCountCircuitOpenedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_distributed_recipient_count_circuit_rejected_total",
      consumerRuntime.customEvents.publishDistributedRecipientCountCircuitRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_distributed_recipient_count_circuit_open",
      consumerRuntime.customEvents.publishDistributedRecipientCountCircuitOpen,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_recipient_count_best_effort_total",
      consumerRuntime.customEvents.publishRecipientCountBestEffortTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_recipient_cap_unverified_total",
      consumerRuntime.customEvents.publishRecipientCapUnverifiedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_fetch_sockets_dedupes_total",
      consumerRuntime.customEvents.publishFetchSocketsDedupesTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_custom_event_publish_idempotency_serialization_tracked_keys",
      getClientSocketEventPublishIdempotencySerializationTrackedKeyCount(),
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_grant_attempts_total",
      consumerRuntime.consumerClientAgentRoomGrant.attemptsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_grant_sockets_joined_total",
      consumerRuntime.consumerClientAgentRoomGrant.socketsJoinedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_grant_join_failures_total",
      consumerRuntime.consumerClientAgentRoomGrant.joinFailuresTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_grant_fetch_failures_total",
      consumerRuntime.consumerClientAgentRoomGrant.fetchFailuresTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_runs_total",
      consumerRuntime.consumerClientAgentRoomReconcile.runsTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_clients_evaluated_total",
      consumerRuntime.consumerClientAgentRoomReconcile.clientsEvaluatedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_clients_deferred_total",
      consumerRuntime.consumerClientAgentRoomReconcile.clientsDeferredTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_sockets_evaluated_total",
      consumerRuntime.consumerClientAgentRoomReconcile.socketsEvaluatedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_rooms_joined_total",
      consumerRuntime.consumerClientAgentRoomReconcile.roomsJoinedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_rooms_left_total",
      consumerRuntime.consumerClientAgentRoomReconcile.roomsLeftTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_failures_total",
      consumerRuntime.consumerClientAgentRoomReconcile.failuresTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_ticks_skipped_total",
      consumerRuntime.consumerClientAgentRoomReconcile.ticksSkippedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_reconcile_in_flight",
      consumerRuntime.consumerClientAgentRoomReconcile.inFlight,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_started_total",
      consumerRuntime.consumerClientAgentRoomBootstrap.startedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_completed_total",
      consumerRuntime.consumerClientAgentRoomBootstrap.completedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_failed_total",
      consumerRuntime.consumerClientAgentRoomBootstrap.failedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_pending",
      consumerRuntime.consumerClientAgentRoomBootstrap.pending,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_duration_sum_ms",
      consumerRuntime.consumerClientAgentRoomBootstrap.durationSumMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_duration_avg_ms",
      consumerRuntime.consumerClientAgentRoomBootstrap.durationAvgMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_duration_max_ms",
      consumerRuntime.consumerClientAgentRoomBootstrap.durationMaxMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_client_agent_room_bootstrap_fetch_reused_total",
      consumerRuntime.consumerClientAgentRoomBootstrap.fetchReusedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_profile_push_recipient_fetch_reused_total",
      consumerRuntime.profilePushRecipientFetch.reusedInFlightTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agent_room_disconnect_triggered_total",
      consumerRuntime.roomDisconnect.agentTriggeredTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumer_room_disconnect_triggered_total",
      consumerRuntime.roomDisconnect.consumerTriggeredTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_consumer_idle_timeout_disconnect_total",
      consumerRuntime.consumerIdleTimeoutDisconnectTotal,
    ),
  );
  for (const [code, value] of Object.entries(hubErrors.engineConnectionErrors)) {
    lines.push(metricLine("plug_socket_engine_connection_errors_total", value, { code }));
  }
  for (const [namespace, value] of Object.entries(hubErrors.namespaceAdapterErrors)) {
    lines.push(metricLine("plug_socket_namespace_adapter_errors_total", value, { namespace }));
  }
  for (const [namespace, value] of Object.entries(hubErrors.namespaceSocketErrors)) {
    lines.push(metricLine("plug_socket_namespace_socket_errors_total", value, { namespace }));
  }
  const recipientHist = consumerRuntime.publishRecipientsHistogram;
  for (const bucket of recipientHist.cumulativeBuckets) {
    lines.push(
      metricLine("plug_socket_custom_event_publish_recipients_hist_bucket", bucket.count, {
        le: bucket.le,
      }),
    );
  }
  lines.push(metricLine("plug_socket_custom_event_publish_recipients_hist_sum", recipientHist.sum));
  lines.push(
    metricLine("plug_socket_custom_event_publish_recipients_hist_count", recipientHist.count),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_profile_push_batches_total",
      consumerRuntime.profilePush.batchesTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_profile_push_coalesced_total",
      consumerRuntime.profilePush.coalescedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_profile_push_fanout_avg",
      consumerRuntime.profilePush.fanoutAvg,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_consumers_profile_push_fanout_max",
      consumerRuntime.profilePush.fanoutMax,
    ),
  );

  lines.push(
    metricLine("plug_socket_relay_requests_accepted_total", relay.counters.requestsAccepted),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_requests_deduplicated_total",
      relay.counters.requestsDeduplicated,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_responses_forwarded_total", relay.counters.responsesForwarded),
  );
  lines.push(
    metricLine("plug_socket_relay_chunks_forwarded_total", relay.counters.chunksForwarded),
  );
  lines.push(metricLine("plug_socket_relay_chunks_buffered_total", relay.counters.chunksBuffered));
  lines.push(metricLine("plug_socket_relay_chunks_dropped_total", relay.counters.chunksDropped));
  lines.push(
    metricLine(
      "plug_socket_relay_stream_terminal_completions_total",
      relay.counters.streamTerminalCompletions,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_stream_idle_timeouts_total", relay.counters.streamIdleTimeouts),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_stream_lifetime_timeouts_total",
      relay.counters.streamLifetimeTimeouts,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_stream_dispatch_slots_released_on_open_total",
      relay.counters.streamDispatchSlotsReleasedOnOpen,
    ),
  );
  lines.push(metricLine("plug_socket_relay_stream_pulls_total", relay.counters.streamPulls));
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_pulls_total",
      relay.counters.restSqlStreamMaterializePulls,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_completed_total",
      relay.counters.restSqlStreamMaterializeCompleted,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_rows_merged_sum",
      relay.counters.restSqlStreamMaterializeRowsMerged,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_row_limit_exceeded_total",
      relay.counters.restMaterializeRowLimitExceeded,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_chunk_limit_exceeded_total",
      relay.counters.restMaterializeChunkLimitExceeded,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_byte_limit_exceeded_total",
      relay.counters.restMaterializeByteLimitExceeded,
    ),
  );
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_active_stream_limit_exceeded_total",
      relay.counters.restMaterializeActiveStreamLimitExceeded,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_request_timeouts_total", relay.counters.requestTimeouts),
  );
  lines.push(
    metricLine("plug_socket_relay_ack_retry_attempts_total", relay.counters.ackRetryAttempts),
  );
  for (const path of ["rest", "relay"] as const) {
    lines.push(
      metricLine(
        "plug_socket_bridge_ack_retry_attempts_total",
        relay.counters.ackRetryAttemptsByPath[path],
        {
          path,
        },
      ),
    );
  }
  lines.push(
    metricLine("plug_socket_relay_ack_retry_exhausted_total", relay.counters.ackRetryExhausted),
  );
  for (const path of ["rest", "relay"] as const) {
    lines.push(
      metricLine(
        "plug_socket_bridge_ack_retry_exhausted_total",
        relay.counters.ackRetryExhaustedByPath[path],
        { path },
      ),
    );
  }
  lines.push(
    metricLine("plug_socket_relay_circuit_open_rejects_total", relay.counters.circuitOpenRejects),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rest_global_pending_cap_rejected_total",
      relay.counters.restGlobalPendingCapRejected,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rest_agent_queue_full_rejected_total",
      relay.counters.restAgentQueueFullRejected,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rest_agent_queue_wait_timeout_rejected_total",
      relay.counters.restAgentQueueWaitTimeoutRejected,
    ),
  );
  const restPendingRejectedLegacy =
    relay.counters.restGlobalPendingCapRejected +
    relay.counters.restAgentQueueFullRejected +
    relay.counters.restAgentQueueWaitTimeoutRejected;
  lines.push(
    metricLine("plug_socket_relay_rest_pending_rejected_total", restPendingRejectedLegacy),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rpc_frame_decode_failed_total",
      relay.counters.rpcFrameDecodeFailed,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_emit_discarded_consumer_gone_total",
      relay.counters.relayEmitDiscardedConsumerGone,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_conversations_expired_total",
      relay.counters.conversationsExpiredTotal,
    ),
  );
  lines.push(metricLine("plug_socket_relay_pending_requests", relay.gauges.pendingRelayRequests));
  lines.push(
    metricLine("plug_socket_relay_rest_pending_requests", relay.gauges.pendingRestRequests),
  );
  lines.push(metricLine("plug_socket_relay_active_streams", relay.gauges.activeStreams));
  lines.push(
    metricLine(
      "plug_rest_sql_stream_materialize_streams_in_flight",
      relay.gauges.restMaterializeStreamsInFlight,
    ),
  );
  lines.push(metricLine("plug_socket_relay_buffered_chunks", relay.gauges.bufferedChunks));
  lines.push(metricLine("plug_socket_relay_open_circuits", relay.gauges.openCircuits));
  lines.push(
    metricLine("plug_socket_relay_overload_checks_total", relay.counters.overloadChecksTotal),
  );
  lines.push(
    metricLine("plug_socket_relay_overload_check_sum_ms", relay.counters.overloadCheckSumMs),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_overload_check_avg_ms",
      relay.counters.overloadChecksTotal > 0
        ? Number(
            (relay.counters.overloadCheckSumMs / relay.counters.overloadChecksTotal).toFixed(4),
          )
        : 0,
    ),
  );
  lines.push(metricLine("plug_socket_relay_frame_decode_count", relay.counters.frameDecodeCount));
  lines.push(metricLine("plug_socket_relay_frame_decode_sum_ms", relay.counters.frameDecodeSumMs));
  lines.push(
    metricLine(
      "plug_socket_relay_frame_decode_avg_ms",
      relay.counters.frameDecodeCount > 0
        ? Number((relay.counters.frameDecodeSumMs / relay.counters.frameDecodeCount).toFixed(4))
        : 0,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_command_validate_count", relay.counters.commandValidateCount),
  );
  lines.push(
    metricLine("plug_socket_relay_command_validate_sum_ms", relay.counters.commandValidateSumMs),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_command_validate_avg_ms",
      relay.counters.commandValidateCount > 0
        ? Number(
            (relay.counters.commandValidateSumMs / relay.counters.commandValidateCount).toFixed(4),
          )
        : 0,
    ),
  );
  lines.push(metricLine("plug_socket_relay_bridge_encode_count", relay.counters.bridgeEncodeCount));
  lines.push(
    metricLine("plug_socket_relay_bridge_encode_sum_ms", relay.counters.bridgeEncodeSumMs),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_bridge_encode_avg_ms",
      relay.counters.bridgeEncodeCount > 0
        ? Number((relay.counters.bridgeEncodeSumMs / relay.counters.bridgeEncodeCount).toFixed(4))
        : 0,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_chunk_forward_jobs_total", relay.counters.chunkForwardJobCount),
  );
  lines.push(
    metricLine("plug_socket_relay_chunk_forward_jobs_sum_ms", relay.counters.chunkForwardJobSumMs),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_chunk_forward_jobs_avg_ms",
      relay.counters.chunkForwardJobCount > 0
        ? Number(
            (relay.counters.chunkForwardJobSumMs / relay.counters.chunkForwardJobCount).toFixed(4),
          )
        : 0,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_buffer_drain_runs_total", relay.counters.bufferDrainRunCount),
  );
  lines.push(metricLine("plug_socket_relay_buffer_drain_sum_ms", relay.counters.bufferDrainSumMs));
  lines.push(
    metricLine(
      "plug_socket_relay_buffer_drain_avg_ms",
      relay.counters.bufferDrainRunCount > 0
        ? Number((relay.counters.bufferDrainSumMs / relay.counters.bufferDrainRunCount).toFixed(4))
        : 0,
    ),
  );

  lines.push(
    metricLine(
      "plug_socket_relay_rest_dispatch_inflight_total",
      relay.restAgentDispatchQueue.totalInflight,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rest_dispatch_queued_waiters_total",
      relay.restAgentDispatchQueue.totalQueuedWaiters,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rest_dispatch_agents_with_queue",
      relay.restAgentDispatchQueue.agentsWithQueuedWaiters,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rest_dispatch_max_queue_depth",
      relay.restAgentDispatchQueue.maxQueueDepthPerAgent,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_dispatch_inflight_total",
      relay.relayAgentDispatchQueue.totalInflight,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_dispatch_queued_waiters_total",
      relay.relayAgentDispatchQueue.totalQueuedWaiters,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_dispatch_agents_with_queue",
      relay.relayAgentDispatchQueue.agentsWithQueuedWaiters,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_dispatch_max_queue_depth",
      relay.relayAgentDispatchQueue.maxQueueDepthPerAgent,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_dispatch_queue_full_rejected_total",
      relay.relayAgentDispatchQueue.queueFullRejected,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_dispatch_queue_wait_timeout_rejected_total",
      relay.relayAgentDispatchQueue.queueWaitTimeoutRejected,
    ),
  );

  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_jobs_enqueued_total",
      relay.relayOutboundQueue.jobsEnqueuedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_jobs_finished_total",
      relay.relayOutboundQueue.jobsFinishedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_jobs_failed_total",
      relay.relayOutboundQueue.jobsFailedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_overload_rejected_total",
      relay.relayOutboundQueue.overloadRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_orphaned_tails_swept_total",
      relay.relayOutboundQueue.orphanedTailsSweptTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_job_duration_sum_ms",
      relay.relayOutboundQueue.jobDurationSumMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_job_duration_avg_ms",
      relay.relayOutboundQueue.jobDurationAvgMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_job_duration_max_ms",
      relay.relayOutboundQueue.jobDurationMaxMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_job_duration_p95_ms",
      relay.relayOutboundQueue.jobDurationP95Ms,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_job_duration_p99_ms",
      relay.relayOutboundQueue.jobDurationP99Ms,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_inflight_request_ids",
      relay.relayOutboundQueue.inflightRequestIds,
    ),
  );
  lines.push(
    metricLine("plug_socket_relay_outbound_queue_backlog", relay.relayOutboundQueue.backlog),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_orphaned_request_ids",
      relay.relayOutboundQueue.orphanedRequestIds,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_overload_state_refresh_total",
      relay.relayOutboundQueue.overloadStateRefreshTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_outbound_queue_overload_cache_p95_ms",
      relay.relayOutboundQueue.overloadCacheP95Ms,
    ),
  );

  for (const latency of relay.latencyByAgent) {
    lines.push(
      metricLine("plug_socket_relay_agent_latency_count", latency.count, {
        agent_id: latency.agentId,
      }),
    );
    lines.push(
      metricLine("plug_socket_relay_agent_latency_avg_ms", latency.avgMs, {
        agent_id: latency.agentId,
      }),
    );
    lines.push(
      metricLine("plug_socket_relay_agent_latency_max_ms", latency.maxMs, {
        agent_id: latency.agentId,
      }),
    );
    lines.push(
      metricLine("plug_socket_relay_agent_latency_p95_ms", latency.p95Ms, {
        agent_id: latency.agentId,
      }),
    );
    lines.push(
      metricLine("plug_socket_relay_agent_latency_p99_ms", latency.p99Ms, {
        agent_id: latency.agentId,
      }),
    );
  }

  lines.push(metricLine("plug_socket_relay_rate_limit_window_ms", rateLimit.windowMs));
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_max_conversation_starts",
      rateLimit.maxConversationStarts,
    ),
  );
  lines.push(metricLine("plug_socket_relay_rate_limit_max_requests", rateLimit.maxRequests));
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_identities_tracked",
      rateLimit.activeIdentitiesTracked,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_conversation_start_allowed_total",
      rateLimit.counters.conversationStartAllowedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_conversation_start_allowed_total",
      rateLimit.counters.conversationStartAllowedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_conversation_start_rejected_total",
      rateLimit.counters.conversationStartRejectedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_conversation_start_rejected_total",
      rateLimit.counters.conversationStartRejectedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_request_allowed_total",
      rateLimit.counters.relayRequestAllowedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_request_allowed_total",
      rateLimit.counters.relayRequestAllowedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_request_rejected_total",
      rateLimit.counters.relayRequestRejectedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_request_rejected_total",
      rateLimit.counters.relayRequestRejectedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_stream_pull_credits_granted_total",
      rateLimit.counters.streamPullCreditsGrantedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_stream_pull_credits_granted_total",
      rateLimit.counters.streamPullCreditsGrantedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_stream_pull_credits_rejected_total",
      rateLimit.counters.streamPullCreditsRejectedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_stream_pull_credits_rejected_total",
      rateLimit.counters.streamPullCreditsRejectedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_stream_pull_rate_limit_max_credits",
      rateLimit.maxAgentsStreamPullCredits,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_stream_pull_rate_limit_credits_granted_total",
      rateLimit.counters.agentsStreamPullCreditsGrantedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_stream_pull_rate_limit_credits_granted_total",
      rateLimit.counters.agentsStreamPullCreditsGrantedAnon,
      { scope: "anon" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_stream_pull_rate_limit_credits_rejected_total",
      rateLimit.counters.agentsStreamPullCreditsRejectedUser,
      { scope: "user" },
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_stream_pull_rate_limit_credits_rejected_total",
      rateLimit.counters.agentsStreamPullCreditsRejectedAnon,
      { scope: "anon" },
    ),
  );

  lines.push(
    metricLine("plug_socket_agents_command_rate_limit_window_ms", agentsCommandRl.windowMs),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_command_rate_limit_max_per_window",
      agentsCommandRl.maxPerWindow,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_command_rate_limit_weighted_costs_enabled",
      agentsCommandRl.weightedCosts ? 1 : 0,
    ),
  );
  lines.push(
    metricLine("plug_socket_agents_command_rate_limit_tracked_keys", agentsCommandRl.trackedKeys),
  );
  lines.push(
    metricLine("plug_socket_agents_command_rate_limit_allowed_total", agentsCommandRl.allowedTotal),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_command_rate_limit_rejected_total",
      agentsCommandRl.rejectedTotal,
    ),
  );

  lines.push(
    metricLine(
      "plug_socket_client_event_publish_rate_limit_window_ms",
      clientSocketEventPublishRl.windowMs,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_client_event_publish_rate_limit_max_per_window",
      clientSocketEventPublishRl.maxPerWindow,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_client_event_publish_rate_limit_tracked_keys",
      clientSocketEventPublishRl.trackedKeys,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_client_event_publish_rate_limit_allowed_total",
      clientSocketEventPublishRl.allowedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_client_event_publish_rate_limit_rejected_total",
      clientSocketEventPublishRl.rejectedTotal,
    ),
  );

  lines.push(metricLine("plug_socket_audit_writes_attempted_total", audit.writesAttempted));
  lines.push(metricLine("plug_socket_audit_writes_succeeded_total", audit.writesSucceeded));
  lines.push(metricLine("plug_socket_audit_writes_failed_total", audit.writesFailed));
  lines.push(
    metricLine(
      "plug_socket_audit_writes_skipped_table_missing_total",
      audit.writesSkippedTableMissing,
    ),
  );
  lines.push(
    metricLine("plug_socket_audit_writes_sample_skipped_total", audit.writesSampleSkipped),
  );
  lines.push(
    metricLine("plug_socket_audit_writes_dropped_overflow_total", audit.writesDroppedOverflow),
  );
  lines.push(metricLine("plug_socket_audit_prune_runs_total", audit.pruneRuns));
  lines.push(metricLine("plug_socket_audit_prune_deleted_total", audit.pruneDeleted));
  lines.push(metricLine("plug_socket_audit_prune_failed_total", audit.pruneFailed));
  lines.push(metricLine("plug_socket_audit_pending_operations", audit.pendingOperations));
  lines.push(metricLine("plug_socket_audit_queued_events", audit.queuedEvents));

  lines.push(metricLine("plug_bridge_latency_trace_enqueued_total", bridgeLatency.enqueued));
  lines.push(
    metricLine("plug_bridge_latency_trace_writes_succeeded_total", bridgeLatency.writesSucceeded),
  );
  lines.push(
    metricLine("plug_bridge_latency_trace_writes_failed_total", bridgeLatency.writesFailed),
  );
  lines.push(
    metricLine(
      "plug_bridge_latency_trace_writes_skipped_table_missing_total",
      bridgeLatency.writesSkippedTableMissing,
    ),
  );
  lines.push(
    metricLine(
      "plug_bridge_latency_trace_writes_dropped_queue_full_total",
      bridgeLatency.writesDroppedQueueFull,
    ),
  );
  lines.push(
    metricLine("plug_bridge_latency_trace_persist_skipped_total", bridgeLatency.persistSkipped),
  );
  lines.push(
    metricLine(
      "plug_bridge_latency_trace_phases_mismatch_total",
      bridgeLatency.phasesMismatchTotal,
    ),
  );
  lines.push(metricLine("plug_bridge_latency_trace_prune_runs_total", bridgeLatency.pruneRuns));
  lines.push(
    metricLine("plug_bridge_latency_trace_prune_deleted_total", bridgeLatency.pruneDeleted),
  );
  lines.push(metricLine("plug_bridge_latency_trace_prune_failed_total", bridgeLatency.pruneFailed));
  lines.push(metricLine("plug_bridge_latency_trace_queued_rows", bridgeLatency.queuedRows));

  /**
   * HTTP RED metrics: counter per `method|route|status_bucket`, histogram per
   * route, and in-flight gauge. Route label is the Express template (e.g.
   * `/agents/catalog/:agentId`), not the raw URL, to keep label cardinality
   * proportional to declared routes — not to the actual IDs in production
   * traffic.
   */
  for (const sample of httpRed.requestsTotal) {
    lines.push(
      metricLine("plug_http_requests_total", sample.value, {
        method: sample.method,
        route: sample.route,
        status_bucket: sample.statusBucket,
      }),
    );
  }
  for (const sample of httpRed.requestsInFlight) {
    lines.push(
      metricLine("plug_http_requests_in_flight", sample.value, {
        method: sample.method,
        route: sample.route,
      }),
    );
  }
  for (const sample of httpRed.requestDurationSeconds) {
    for (const bucket of sample.buckets) {
      lines.push(
        metricLine("plug_http_request_duration_seconds_bucket", bucket.count, {
          method: sample.method,
          route: sample.route,
          status_bucket: sample.statusBucket,
          le: String(bucket.le),
        }),
      );
    }
    /**
     * Prometheus histograms also need the `+Inf` bucket and the `_count` /
     * `_sum` aggregators; the +Inf bucket equals the total count by
     * definition.
     */
    lines.push(
      metricLine("plug_http_request_duration_seconds_bucket", sample.count, {
        method: sample.method,
        route: sample.route,
        status_bucket: sample.statusBucket,
        le: "+Inf",
      }),
    );
    lines.push(
      metricLine("plug_http_request_duration_seconds_count", sample.count, {
        method: sample.method,
        route: sample.route,
        status_bucket: sample.statusBucket,
      }),
    );
    lines.push(
      metricLine("plug_http_request_duration_seconds_sum", sample.sumSeconds, {
        method: sample.method,
        route: sample.route,
        status_bucket: sample.statusBucket,
      }),
    );
  }

  return lines;
};
