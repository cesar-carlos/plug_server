import type { Request, Response } from "express";

import { getRestBridgeMetricsSnapshot } from "../../../application/services/rest_bridge_metrics.service";
import { getSocketAuditMetricsSnapshot } from "../../../application/services/socket_audit.service";
import { getSocketMetricsSnapshot } from "../../../socket";

const escapePrometheusLabelValue = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");

const metricLine = (
  name: string,
  value: number,
  labels?: Record<string, string>,
): string => {
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
  const audit = getSocketAuditMetricsSnapshot();

  const lines: string[] = [];

  lines.push(metricLine("plug_rest_bridge_requests_total", restBridge.requestsTotal));
  lines.push(metricLine("plug_rest_bridge_requests_success_total", restBridge.requestsSuccessTotal));
  lines.push(metricLine("plug_rest_bridge_requests_failed_total", restBridge.requestsFailedTotal));
  lines.push(metricLine("plug_rest_bridge_latency_count", restBridge.latencyCount));
  lines.push(metricLine("plug_rest_bridge_latency_avg_ms", restBridge.latencyAvgMs));
  lines.push(metricLine("plug_rest_bridge_latency_max_ms", restBridge.latencyMaxMs));
  lines.push(metricLine("plug_rest_bridge_latency_p95_ms", restBridge.latencyP95Ms));
  lines.push(metricLine("plug_rest_bridge_latency_p99_ms", restBridge.latencyP99Ms));

  lines.push(metricLine("plug_socket_namespace_connections", socket.namespaces.agents, { namespace: "agents" }));
  lines.push(
    metricLine("plug_socket_namespace_connections", socket.namespaces.consumers, { namespace: "consumers" }),
  );

  lines.push(metricLine("plug_socket_relay_requests_accepted_total", relay.counters.requestsAccepted));
  lines.push(metricLine("plug_socket_relay_requests_deduplicated_total", relay.counters.requestsDeduplicated));
  lines.push(metricLine("plug_socket_relay_responses_forwarded_total", relay.counters.responsesForwarded));
  lines.push(metricLine("plug_socket_relay_chunks_forwarded_total", relay.counters.chunksForwarded));
  lines.push(metricLine("plug_socket_relay_chunks_buffered_total", relay.counters.chunksBuffered));
  lines.push(metricLine("plug_socket_relay_chunks_dropped_total", relay.counters.chunksDropped));
  lines.push(metricLine("plug_socket_relay_stream_pulls_total", relay.counters.streamPulls));
  lines.push(
    metricLine("plug_rest_sql_stream_materialize_pulls_total", relay.counters.restSqlStreamMaterializePulls),
  );
  lines.push(metricLine("plug_socket_relay_request_timeouts_total", relay.counters.requestTimeouts));
  lines.push(metricLine("plug_socket_relay_circuit_open_rejects_total", relay.counters.circuitOpenRejects));
  lines.push(metricLine("plug_socket_relay_rest_pending_rejected_total", relay.counters.restPendingRejected));
  lines.push(metricLine("plug_socket_relay_rpc_frame_decode_failed_total", relay.counters.rpcFrameDecodeFailed));
  lines.push(metricLine("plug_socket_relay_pending_requests", relay.gauges.pendingRelayRequests));
  lines.push(metricLine("plug_socket_relay_rest_pending_requests", relay.gauges.pendingRestRequests));
  lines.push(metricLine("plug_socket_relay_active_streams", relay.gauges.activeStreams));
  lines.push(metricLine("plug_socket_relay_buffered_chunks", relay.gauges.bufferedChunks));
  lines.push(metricLine("plug_socket_relay_open_circuits", relay.gauges.openCircuits));

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
  lines.push(metricLine("plug_socket_relay_rate_limit_max_conversation_starts", rateLimit.maxConversationStarts));
  lines.push(metricLine("plug_socket_relay_rate_limit_max_requests", rateLimit.maxRequests));
  lines.push(metricLine("plug_socket_relay_rate_limit_consumers_tracked", rateLimit.activeConsumersTracked));
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_conversation_start_allowed_total",
      rateLimit.counters.conversationStartAllowed,
    ),
  );
  lines.push(
    metricLine(
      "plug_socket_relay_rate_limit_conversation_start_rejected_total",
      rateLimit.counters.conversationStartRejected,
    ),
  );
  lines.push(metricLine("plug_socket_relay_rate_limit_request_allowed_total", rateLimit.counters.relayRequestAllowed));
  lines.push(
    metricLine("plug_socket_relay_rate_limit_request_rejected_total", rateLimit.counters.relayRequestRejected),
  );

  lines.push(metricLine("plug_socket_audit_writes_attempted_total", audit.writesAttempted));
  lines.push(metricLine("plug_socket_audit_writes_succeeded_total", audit.writesSucceeded));
  lines.push(metricLine("plug_socket_audit_writes_failed_total", audit.writesFailed));
  lines.push(metricLine("plug_socket_audit_writes_skipped_table_missing_total", audit.writesSkippedTableMissing));
  lines.push(metricLine("plug_socket_audit_prune_runs_total", audit.pruneRuns));
  lines.push(metricLine("plug_socket_audit_prune_deleted_total", audit.pruneDeleted));
  lines.push(metricLine("plug_socket_audit_prune_failed_total", audit.pruneFailed));
  lines.push(metricLine("plug_socket_audit_pending_operations", audit.pendingOperations));
  lines.push(metricLine("plug_socket_audit_queued_events", audit.queuedEvents));

  response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  response.status(200).send(`${lines.join("\n")}\n`);
};
