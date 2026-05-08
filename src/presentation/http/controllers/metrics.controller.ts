import type { Request, Response } from "express";

import { getBridgeLatencyTraceMetricsSnapshot } from "../../../application/services/bridge_latency_trace.service";
import { getAgentDataMaintenanceMetricsSnapshot } from "../../../application/services/agent_data_maintenance.service";
import { getRestBridgeMetricsSnapshot } from "../../../application/services/rest_bridge_metrics.service";
import { getRestHttpRateLimitMetricsSnapshot } from "../../../application/services/rest_http_rate_limit_metrics.service";
import { getRestRateLimitRedisMetricsSnapshot } from "../../../application/services/rest_rate_limit_redis_metrics.service";
import { agentProfileReliabilityMetrics } from "../../../application/services/agent_profile_reliability_metrics.service";
import { getAuthAccountMetricsSnapshot } from "../../../shared/metrics/auth_account.metrics";
import { getClientAgentAccessPublicDecisionMetricsSnapshot } from "../../../shared/metrics/client_agent_access_public_decision.metrics";
import { getClientAgentAccessRequestPostMetricsSnapshot } from "../../../shared/metrics/client_agent_access_request.metrics";
import { getClientMeAgentsMetricsSnapshot } from "../../../shared/metrics/client_me_agents.metrics";
import { getRegistrationFlowMetricsSnapshot } from "../../../shared/metrics/registration_flow.metrics";
import { getSocketAuditMetricsSnapshot } from "../../../application/services/socket_audit.service";
import { getSocketMetricsSnapshot } from "../../../socket";

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

const metricsResponseCacheTtlMs = 500;
let metricsResponseCache: {
  body: string;
  expiresAtMs: number;
} | null = null;

export const getMetrics = (_request: Request, response: Response): void => {
  const nowMs = Date.now();
  const cached = metricsResponseCache;
  if (cached && cached.expiresAtMs > nowMs) {
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.status(200).send(cached.body);
    return;
  }

  const socket = getSocketMetricsSnapshot();
  const restBridge = getRestBridgeMetricsSnapshot();
  const relay = socket.relay;
  const rateLimit = socket.relayRateLimit;
  const socketRateLimitRedis = socket.socketRateLimitRedis;
  const agentsCommandRl = socket.agentsCommandSocketRateLimit;
  const consumerRuntime = socket.consumerRuntime;
  const agentRuntime = socket.agentRuntime;
  const audit = getSocketAuditMetricsSnapshot();
  const bridgeLatency = getBridgeLatencyTraceMetricsSnapshot();
  const agentDataMaintenance = getAgentDataMaintenanceMetricsSnapshot();
  const restHttpRl = getRestHttpRateLimitMetricsSnapshot();
  const restRateLimitRedis = getRestRateLimitRedisMetricsSnapshot();
  const registrationFlow = getRegistrationFlowMetricsSnapshot();
  const authAccount = getAuthAccountMetricsSnapshot();
  const clientMeAgents = getClientMeAgentsMetricsSnapshot();
  const clientAccessRequestPost = getClientAgentAccessRequestPostMetricsSnapshot();
  const clientAccessPublicDecision = getClientAgentAccessPublicDecisionMetricsSnapshot();

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

  lines.push(
    metricLine("plug_socket_rate_limit_redis_url_configured", socketRateLimitRedis.redisUrlConfigured),
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
    metricLine("plug_socket_rate_limit_redis_allowed_total", socketRateLimitRedis.redisAllowedTotal),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_rejected_total",
      socketRateLimitRedis.redisRejectedTotal,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_rate_limit_redis_tracked_keys_approx",
      socketRateLimitRedis.trackedKeysApprox,
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
      "plug_agent_session_register_rate_limited_total",
      agentRuntime.sessionRegisterRateLimitedTotal,
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

  const body = `${lines.join("\n")}\n`;
  metricsResponseCache = {
    body,
    expiresAtMs: nowMs + metricsResponseCacheTtlMs,
  };
  response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(body);
};
