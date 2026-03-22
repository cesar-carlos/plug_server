-- Hourly rollups for dashboards (Grafana/SQL). Refresh by querying the base table; view is not materialized.
CREATE OR REPLACE VIEW bridge_latency_trace_hourly_rollups AS
SELECT
  date_trunc('hour', created_at AT TIME ZONE 'UTC') AS hour_utc,
  channel,
  outcome,
  json_rpc_method,
  COUNT(*)::bigint AS request_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms::double precision) AS p50_total_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms::double precision) AS p95_total_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms::double precision) AS p99_total_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (phases_ms->>'agent_to_hub_ms')::double precision)
    FILTER (WHERE phases_ms ? 'agent_to_hub_ms') AS p95_agent_to_hub_ms
FROM bridge_latency_traces
GROUP BY 1, 2, 3, 4;
