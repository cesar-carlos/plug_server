import type { Request, Response } from "express";

import { getBridgeLatencyTraceMetricsSnapshot } from "../../../application/services/bridge_latency_trace.service";
import { getRestBridgeMetricsSnapshot } from "../../../application/services/rest_bridge_metrics.service";
import { getRestHttpRateLimitMetricsSnapshot } from "../../../application/services/rest_http_rate_limit_metrics.service";
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

export const getMetrics = (_request: Request, response: Response): void => {
  const socket = getSocketMetricsSnapshot();
  const restBridge = getRestBridgeMetricsSnapshot();
  const relay = socket.relay;
  const rateLimit = socket.relayRateLimit;
  const agentsCommandRl = socket.agentsCommandSocketRateLimit;
  const audit = getSocketAuditMetricsSnapshot();
  const bridgeLatency = getBridgeLatencyTraceMetricsSnapshot();
  const restHttpRl = getRestHttpRateLimitMetricsSnapshot();
  const registrationFlow = getRegistrationFlowMetricsSnapshot();

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
    metricLine("plug_socket_agents_command_rate_limit_window_ms", agentsCommandRl.windowMs),
  );
  lines.push(
    metricLine(
      "plug_socket_agents_command_rate_limit_max_per_window",
      agentsCommandRl.maxPerWindow,
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

  response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  response.status(200).send(`${lines.join("\n")}\n`);
};
