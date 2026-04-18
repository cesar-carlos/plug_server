-- Convert `bridge_latency_trace_hourly_rollups` from a regular VIEW into a
-- MATERIALIZED VIEW. The previous regular view re-aggregated the entire
-- bridge_latency_traces table on every SELECT, which becomes prohibitively
-- expensive once the table grows past a few million rows (90-day retention).
--
-- The new materialized view is refreshed by a scheduler job in
-- `src/application/services/bridge_latency_trace_rollup.service.ts` using
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (requires a UNIQUE index, defined
-- below). CONCURRENTLY allows readers to keep using the previous snapshot
-- during refresh, with no read-side locking.
--
-- Rollback: DROP MATERIALIZED VIEW + recreate the regular view from the
-- previous migration body.

DROP VIEW IF EXISTS bridge_latency_trace_hourly_rollups;

CREATE MATERIALIZED VIEW bridge_latency_trace_hourly_rollups AS
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
GROUP BY 1, 2, 3, 4
WITH NO DATA;

-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY: every row must be
-- uniquely identifiable. The four GROUP BY columns are the natural key.
-- COALESCE'd because `outcome` and `json_rpc_method` may be NULL and unique
-- indexes treat NULLs as distinct, but explicit handling is more portable
-- across older PG versions.
CREATE UNIQUE INDEX bridge_latency_trace_hourly_rollups_unique_idx
  ON bridge_latency_trace_hourly_rollups (
    hour_utc,
    channel,
    COALESCE(outcome, ''),
    COALESCE(json_rpc_method, '')
  );

CREATE INDEX bridge_latency_trace_hourly_rollups_hour_utc_idx
  ON bridge_latency_trace_hourly_rollups (hour_utc);

CREATE INDEX bridge_latency_trace_hourly_rollups_channel_hour_idx
  ON bridge_latency_trace_hourly_rollups (channel, hour_utc);

-- Initial population. Runs synchronously during migration (one-shot, retention
-- means the source table starts small after deploy). Subsequent refreshes go
-- through the scheduled CONCURRENTLY job.
REFRESH MATERIALIZED VIEW bridge_latency_trace_hourly_rollups;
